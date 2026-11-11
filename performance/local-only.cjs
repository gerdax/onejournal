/* Preload for existing fixture browser tests: deny every non-loopback request. */
'use strict';
const { chromium } = require('playwright');
const launch = chromium.launch.bind(chromium);
const guarded = new WeakSet();
async function guard(context) {
  if (guarded.has(context)) return;
  guarded.add(context);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.protocol === 'data:' || url.protocol === 'blob:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await context.routeWebSocket('**/*', socket => socket.close());
}
chromium.launch = async options => {
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser), newPage = browser.newPage.bind(browser);
  browser.newContext = async options => { const context = await newContext({ ...options, serviceWorkers: 'block' }); await guard(context); return context; };
  browser.newPage = async options => { const page = await newPage({ ...options, serviceWorkers: 'block' }); await guard(page.context()); return page; };
  return browser;
};
