// UI_CORE_EDITS=1 (run-ui-checks.mjs): the UI checks run with the "new edit engine"
// setting on (document core, migration P3-6). Loaded with `node --import` before
// ui-check-shim.mjs, so the setting is stored and the page reloaded before the demo opens.
import {_electron} from '@playwright/test';
const launch=_electron.launch.bind(_electron);
_electron.launch=async(...args)=>{
 const app=await launch(...args),first=app.firstWindow.bind(app);let done=false;
 app.firstWindow=async(...rest)=>{
  const page=await first(...rest);
  if(!done){done=true;await page.waitForLoadState('domcontentloaded');
   await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('tabstudio-settings')||'{}');s.coreEdits=true;localStorage.setItem('tabstudio-settings',JSON.stringify(s));});
   await page.reload();await page.waitForLoadState('domcontentloaded');}
  return page;
 };
 return app;
};
