// Older UI checks predate the start screen (startup: 'home' is the default since 1.0).
// Loaded with `node --import`, this opens the demo score in the first window so those
// scripts start from the state they were written for. Scripts that click #start-demo
// themselves are run without it (see run-ui-checks.mjs).
import {_electron} from '@playwright/test';
const launch=_electron.launch.bind(_electron);
_electron.launch=async(...args)=>{
 const app=await launch(...args),first=app.firstWindow.bind(app);let opened=false;
 app.firstWindow=async(...rest)=>{const page=await first(...rest);if(!opened){opened=true;await page.locator('#start-demo').click({timeout:30000}).catch(()=>{});}return page;};
 return app;
};
