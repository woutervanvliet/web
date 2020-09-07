import { Page, ConsoleMessage } from 'puppeteer-core';
import {
  TestRunnerCoreConfig,
  getBrowserPageNavigationError,
  TestResultError,
  CoverageMapData,
} from '@web/test-runner-core';
import { V8Coverage, v8ToIstanbul } from '@web/test-runner-coverage-v8';
import { browserScript, deserialize } from '@web/browser-logs';
import { SessionResult } from '@web/test-runner-core';

// these warnings are generated by mocha
const filteredBrowserWarnings = [
  "'window.webkitStorageInfo' is deprecated.",
  'onmozfullscreenchange is deprecated.',
  'onmozfullscreenerror is deprecated.',
];

function filterBrowserLogs(browserLogs: any[][]) {
  return browserLogs.filter(log => {
    return !(
      log.length === 1 &&
      typeof log[0] === 'string' &&
      filteredBrowserWarnings.some(warn => log[0].includes(warn))
    );
  });
}

export class ChromeLauncherPage {
  private config: TestRunnerCoreConfig;
  private testFiles: string[];
  private product: string;
  public puppeteerPage: Page;
  private nativeInstrumentationEnabledOnPage = false;
  private logs: Promise<any[]>[] = [];
  private testURL?: URL;
  private navigations: URL[] = [];

  constructor(
    config: TestRunnerCoreConfig,
    testFiles: string[],
    product: string,
    puppeteerPage: Page,
  ) {
    this.config = config;
    this.testFiles = testFiles;
    this.product = product;
    this.puppeteerPage = puppeteerPage;

    // inject serialization script
    puppeteerPage.evaluateOnNewDocument(browserScript);

    // track browser navigations
    puppeteerPage.on('request', e => {
      if (e.isNavigationRequest()) {
        this.navigations.push(new URL(e.url()));
      }
    });

    if (config.logBrowserLogs !== false) {
      puppeteerPage.on('console', this.onConsoleMessage);
    }
  }

  async runSession(url: string, coverage: boolean) {
    this.testURL = new URL(url);
    this.navigations = [];

    if (
      coverage &&
      this.config.coverageConfig?.nativeInstrumentation !== false &&
      this.product === 'chromium'
    ) {
      if (this.nativeInstrumentationEnabledOnPage) {
        await this.puppeteerPage.coverage.stopJSCoverage();
      }
      this.nativeInstrumentationEnabledOnPage = true;
      await this.puppeteerPage.coverage.startJSCoverage();
    }

    this.logs = [];
    await this.puppeteerPage.setViewport({ height: 600, width: 800 });
    await this.puppeteerPage.goto(url);
  }

  async stopSession(): Promise<SessionResult> {
    const errors: TestResultError[] = [];
    let testCoverage: CoverageMapData | undefined;
    let browserLogs: any[][] = [];

    // check if the page was navigated, resulting in broken tests
    const navigationError = getBrowserPageNavigationError(this.testURL!, this.navigations);
    if (navigationError) {
      errors.push(navigationError);
    } else {
      [testCoverage, browserLogs] = await Promise.all([
        this.collectTestCoverage(this.config, this.testFiles),
        Promise.all(this.logs),
      ]);
      browserLogs = filterBrowserLogs(browserLogs);
    }

    // navigate to an empty page to kill any running code on the page, stopping timers and
    // breaking a potential endless reload loop
    await this.puppeteerPage.goto('data:,');

    return { testCoverage, browserLogs, errors };
  }

  private async collectTestCoverage(config: TestRunnerCoreConfig, testFiles: string[]) {
    const coverageFromBrowser = await this.puppeteerPage.evaluate(
      () => (window as any).__coverage__,
    );

    if (coverageFromBrowser) {
      // coverage was generated by JS, return that
      return coverageFromBrowser;
    }

    if (config.coverageConfig?.nativeInstrumentation === false) {
      throw new Error(
        'Coverage is enabled with nativeInstrumentation disabled. ' +
          'Expected coverage provided in the browser as a global __coverage__ variable.' +
          'Use a plugin like babel-plugin-istanbul to generate the coverage, or enable native instrumentation.',
      );
    }

    if (!this.nativeInstrumentationEnabledOnPage) {
      return undefined;
    }

    // get native coverage from puppeteer
    // TODO: this is using a private puppeteer API to grab v8 code coverage, this can be removed
    // when https://github.com/puppeteer/puppeteer/issues/2136 is resolved
    const response = (await (this.puppeteerPage as any)._client.send(
      'Profiler.takePreciseCoverage',
    )) as {
      result: V8Coverage[];
    };
    // puppeteer already has the script sources available, remove this when above issue is resolved
    const scriptSources = (this.puppeteerPage as any)?.coverage?._jsCoverage?._scriptSources;

    const v8Coverage = response.result
      // remove puppeteer specific scripts
      .filter(r => r.url && r.url !== '__puppeteer_evaluation_script__')
      // attach source code
      .map(r => ({
        ...r,
        source: scriptSources.get(r.scriptId),
      }));

    await this.puppeteerPage.coverage?.stopJSCoverage();
    this.nativeInstrumentationEnabledOnPage = false;
    return v8ToIstanbul(config, testFiles, v8Coverage);
  }

  private onConsoleMessage = (message: ConsoleMessage) => {
    if (!this.collectMessageType(message.type())) {
      return;
    }

    const args = message.args();
    if (args.length > 0) {
      const logsPromise = message.args().map(arg =>
        arg
          // serialize the log message in the browser to a string
          // __wtr_browser_logs__ is injected by a script, but in some cases we're setting it isn't available
          // for example for browser native warnings
          .evaluateHandle(e =>
            (window as any).__wtr_browser_logs__
              ? (window as any).__wtr_browser_logs__.serialize(e)
              : JSON.stringify(e),
          )
          // pass along the message from the browser to NodeJS as a string
          .then(handle => handle.jsonValue())
          // deserialize the string to an array of logs
          .then(str => deserialize(str as string))
          .catch(err => `Error while collecting browser logs: ${err.message}`),
      );
      this.logs.push(Promise.all(logsPromise));
    } else {
      this.logs.push(Promise.resolve([message.text()]));
    }
  };

  private collectMessageType(type: string) {
    return (
      this.config.logBrowserLogs === true ||
      (Array.isArray(this.config.logBrowserLogs) &&
        this.config.logBrowserLogs.includes(type as any))
    );
  }
}
