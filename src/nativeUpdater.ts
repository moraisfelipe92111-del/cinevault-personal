import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { Release } from './release'

interface Version { version:string; build:number }
interface UpdaterPlugin {
  getInstalledVersion():Promise<Version>
  downloadAndInstall(args:{url:string;sha256:string;build:number}):Promise<{status:string}>
  addListener(eventName:'downloadProgress', listener:(data:{percent:number})=>void):Promise<PluginListenerHandle>
}
const Updater=registerPlugin<UpdaterPlugin>('CineVaultUpdater')
export function nativeUpdateAvailable(){return Capacitor.isNativePlatform()&&Capacitor.getPlatform()==='android'}
export async function currentInstalledBuild(fallback:number){
  if(!nativeUpdateAvailable())return fallback
  try{
    const {build}=await Updater.getInstalledVersion()
    return Number.isSafeInteger(build)&&build>0?build:fallback
  }catch{return fallback}
}
export async function beginNativeUpdate(release:Release,onProgress:(p:number)=>void):Promise<string>{
  if(!nativeUpdateAvailable())throw Error('Instalador disponível somente no APK Android.')
  let handler:PluginListenerHandle|undefined
  try{
    handler=await Updater.addListener('downloadProgress',({percent})=>onProgress(Math.max(0,Math.min(100,percent))))
    const result=await Updater.downloadAndInstall({url:release.url,sha256:release.sha256,build:release.build})
    return result.status
  }finally{await handler?.remove()}
}
