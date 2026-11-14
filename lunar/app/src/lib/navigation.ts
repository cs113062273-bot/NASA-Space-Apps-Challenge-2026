export type WorkspacePage='home'|'explore'|'whatif'|'compare'|'engineering'|'reference'
export interface WorkspaceLocation {page:WorkspacePage;section:string}
/** Top-level pages: the story, the planning workspace, three task pages, and the evidence. */
export const WORKSPACE_PAGES:{id:WorkspacePage;target:string;label:string;icon:string}[]=[
  {id:'home',target:'home',label:'Home',icon:'home'},
  {id:'explore',target:'explore',label:'Plan',icon:'plan'},
  {id:'whatif',target:'whatif',label:'Delays',icon:'delay'},
  {id:'compare',target:'compare',label:'Compare',icon:'compare'},
  {id:'engineering',target:'terrain-area',label:'Engineering',icon:'engineering'},
  {id:'reference',target:'cases',label:'Evidence',icon:'evidence'}
]
export function workspaceLocation(hash:string,fallback:WorkspacePage='explore'):WorkspaceLocation {
  const id=hash.replace(/^#/,'')
  // terrain, power and communication are the three engineering sub-pages
  if(['terrain-area','power','communication','systems','engineering'].includes(id))return {page:'engineering',section:id==='systems'?'power':id==='engineering'?'terrain-area':id}
  if(['upcoming','cases','evidence','reference'].includes(id))return {page:'reference',section:id==='reference'?'cases':id}
  // delay recovery and the date/touchdown sensitivity share one page
  if(id==='decision')return {page:'whatif',section:'decision'}
  // site comparison and the site-date search share one page
  if(id==='search')return {page:'compare',section:'search'}
  const page=WORKSPACE_PAGES.find(p=>p.id===id)?.id??fallback
  return {page,section:WORKSPACE_PAGES.find(p=>p.id===page)!.target}
}
