/** Manifests signed off by the publisher; every APK must also pass native SHA-256 and signer checks. */
export const LOCAL_RELEASE = { version: '1.3.0', build: 13 } as const
export const RELEASE_MANIFEST_URL = 'https://raw.githubusercontent.com/moraisfelipe92111-del/cinevault-personal/main/releases/latest.json'
const OWNER='moraisfelipe92111-del', REPO='cinevault-personal'
const BASE=`/${OWNER}/${REPO}/releases/download/`
export type Release = {
  version: string
  build: number
  title: string
  notes: string[]
  url: string
  sha256: string
  required: boolean
}
function object(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)}
function signedAssetUrl(value:unknown,version:string):value is string{
  if(typeof value!=='string')return false
  try{
    const u=new URL(value)
    return u.protocol==='https:' && u.hostname==='github.com' &&
      u.username==='' && u.password==='' && u.search==='' && u.hash==='' &&
      u.pathname.startsWith(BASE) &&
      u.pathname.slice(BASE.length).startsWith(`v${version}/`) &&
      /^\/[^/]+\.apk$/i.test(u.pathname.slice(BASE.length+`v${version}`.length))
  }catch{return false}
}
export function parseRelease(input:unknown):Release|null{
  if(!object(input)||typeof input.version!=='string'||!/^[1-9]\d*\.\d+\.\d+$/.test(input.version)||
    typeof input.build!=='number'||!Number.isSafeInteger(input.build)||input.build<1||
    !signedAssetUrl(input.url,input.version)||
    typeof input.sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(input.sha256)||
    typeof input.title!=='string'||!input.title.trim()||input.title.length>100||
    !Array.isArray(input.notes)||input.notes.length>8||
    !input.notes.every((s:unknown)=>typeof s==='string'&&s.trim().length>0&&s.length<=200)||
    (input.required!==undefined&&typeof input.required!=='boolean'))return null
  return {version:input.version,build:input.build,title:input.title.trim(),notes:input.notes,url:input.url,sha256:input.sha256.toLowerCase(),required:input.required===true}
}
export function newerThanInstalled(r:Release|null,installedBuild:number=LOCAL_RELEASE.build):boolean {
  return !!r && Number.isSafeInteger(installedBuild) && r.build>installedBuild
}
export async function fetchLatestRelease(fetcher:typeof fetch=fetch,installedBuild:number=LOCAL_RELEASE.build):Promise<Release|null>{
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(),7000)
  try{
    const result=await fetcher(RELEASE_MANIFEST_URL,{cache:'no-store',signal:controller.signal,redirect:'error'})
    if(!result.ok)return null
    const content=await result.text()
    if(content.length>8192)return null
    const parsed=parseRelease(JSON.parse(content))
    return newerThanInstalled(parsed,installedBuild)?parsed:null
  }catch{return null}
  finally{clearTimeout(timer)}
}
