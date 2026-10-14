/** CineVault original sonic signatures. No audio APIs are used before the first playback request. */
export type SonicStyle='cinema'|'aura'
export const SONIC_FILES:Readonly<Record<SonicStyle,string>>={
  cinema:'/audio/cinevault-signature.mp3',
  aura:'/audio/cinevault-aura.mp3'
}
let active:HTMLAudioElement|null=null
export function stopBrandAudio(){
  if(active){active.pause();active.currentTime=0;active=null}
}
export async function playBrandAudio(style:SonicStyle='cinema',volume=.65):Promise<boolean>{
  if(typeof Audio==='undefined')return false
  stopBrandAudio()
  try{
    const el=new Audio(SONIC_FILES[style])
    el.preload='auto'
    el.volume=Math.max(0,Math.min(1,Number.isFinite(volume)?volume:.65))
    active=el
    el.addEventListener('ended',()=>{if(active===el)active=null},{once:true})
    await el.play()
    return true
  }catch{
    stopBrandAudio()
    // In Chrome an autoplay restriction is normal; replay from a user gesture works.
    return false
  }
}
