/** Original CineVault identity themes; legacy choices remain playable. */
export type SonicStyle='signature'|'noir'|'impacto'|'cinema'|'aura'
export const SONIC_FILES:Readonly<Record<SonicStyle,string>>={
  signature:'/audio/CineVault_Signature.mp3',
  noir:'/audio/CineVault_Noir.mp3',
  impacto:'/audio/CineVault_Impacto.mp3',
  cinema:'/audio/cinevault-signature.mp3',
  aura:'/audio/cinevault-aura.mp3'
}
let active:HTMLAudioElement|null=null
export function stopBrandAudio(){
  const item=active
  active=null
  if(item){try{item.pause();item.currentTime=0}catch{/* media unavailable */}}
}
export async function playBrandAudio(style:SonicStyle='signature',volume=.60):Promise<boolean>{
  if(typeof Audio==='undefined')return false
  stopBrandAudio()
  const src=SONIC_FILES[style]||SONIC_FILES.signature
  try {
    const el=new Audio(src)
    el.preload='auto'
    el.volume=Math.max(0,Math.min(1,Number.isFinite(volume)?volume:.60))
    active=el
    el.addEventListener('ended',()=>{if(active===el)active=null},{once:true})
    await el.play()
    return true
  } catch {
    stopBrandAudio()
    return false
  }
}
