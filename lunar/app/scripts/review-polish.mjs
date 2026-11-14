import {chromium} from 'playwright'
import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

const base=process.env.LASTLIGHT_URL||'http://127.0.0.1:5180',output=new URL('../test-results/',import.meta.url),errors=[]
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:900},locale:'zh-TW',timezoneId:'Asia/Taipei'}),page=await context.newPage()
page.setDefaultTimeout(15000)
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
let release;const sourceGate=new Promise(r=>release=r)
await page.route('**/stations.f32',async route=>{await sourceGate;await route.continue()})
try{
  await page.goto(base)
  await page.getByRole('heading',{name:'One week can change a lunar landing.',exact:true}).waitFor()
  await page.screenshot({path:fileURLToPath(new URL('startup-1440x900.png',output))})
  release()
  await page.locator('#home-title').waitFor({timeout:60000});await page.evaluate(()=>document.fonts.ready)
  assert.match(await page.locator('.case-card').innerText(),/days late/);await page.screenshot({path:fileURLToPath(new URL('home-1440x900.png',output))})
  await page.getByRole('navigation',{name:'Workspace pages',exact:true}).getByRole('link',{name:'Plan',exact:true}).click();await page.locator('.headline').waitFor()
  const date=page.getByRole('textbox',{name:'Landing (UTC)',exact:true})
  assert.match(await date.inputValue(),/^\d{4}-\d\d-\d\d \d\d:\d\d$/)
  await date.fill('2027-01-08 13:30');await date.press('Tab');assert.equal(await date.inputValue(),'2027-01-08 14:00')
  const valid=page.url();await date.fill('2027-02-30 12:00');await date.press('Tab');assert.equal(await date.getAttribute('aria-invalid'),'true');assert.equal(page.url(),valid)
  await date.focus();await date.press('Escape');assert.equal(await date.inputValue(),'2027-01-08 14:00');assert.equal(await date.getAttribute('aria-invalid'),null)
  await date.fill('2027-01-01 00:00');await date.press('Tab')
  assert.ok(await page.locator('.mb-field').filter({hasText:'Panel height'}).getAttribute('title'))
  assert.ok(await page.locator('.mb-field').filter({hasText:'Earth clearance'}).getAttribute('title'))
  for(const [width,height] of [[1440,900],[1263,560],[1903,950],[1366,768]]){
    await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  }
  await page.setViewportSize({width:1440,height:900});await page.screenshot({path:fileURLToPath(new URL('polished-overview-1440x900.png',output))})
  const nav=page.getByRole('navigation',{name:'Workspace pages',exact:true});await nav.getByRole('link',{name:'Compare',exact:true}).click();await page.getByRole('navigation',{name:'Alternative pages',exact:true}).getByRole('link',{name:'Find a plan',exact:true}).click()
  await page.locator('.search-results:not(.stale)').waitFor({timeout:90000})
  assert.match(await page.locator('#search [role=status]').innerText(),/plans? pass/)
  await nav.getByRole('link',{name:'Engineering',exact:true}).click();await page.getByRole('navigation',{name:'Engineering pages',exact:true}).getByRole('link',{name:'Power & temperature',exact:true}).click();await page.locator('#power').waitFor()
  assert.ok(await page.locator('#power .model-note').first().evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=13))
  await page.screenshot({path:fileURLToPath(new URL('polished-power-1440x900.png',output))})
  await page.getByRole('navigation',{name:'Engineering pages',exact:true}).getByRole('link',{name:'Terrain & routes',exact:true}).click();await page.locator('.terrain-verdict').waitFor()
  const limits=page.getByText('Terrain resolution & interpretation',{exact:true});assert.equal(await limits.isVisible(),true)
  await nav.getByRole('link',{name:'Home',exact:true}).click();await page.getByRole('button',{name:/Recover a delayed landing/}).click()
  await page.locator('#decision').waitFor();assert.match(await page.locator('#decision').innerText(),/6 sites pass/)
  await page.locator('#decision').scrollIntoViewIfNeeded();await page.screenshot({path:fileURLToPath(new URL('polished-decision-1440x900.png',output))})
  assert.deepEqual(errors,[])
  await writeFile(new URL('polish-report.json',output),JSON.stringify({checkedUTC:new Date().toISOString(),base,locale:'zh-TW',desktop:true,checks:['real loading feedback','24-hour UTC commit/invalid/Escape','plain toolbar help','four desktop widths','automatic real search','readable system notes','folded terrain limits','delay recovery'],errors},null,2))
  console.log('PASS desktop first-use polish, UTC input, automatic search and delay recovery')
}finally{await browser.close()}
