const $=id=>document.getElementById(id)
let csrf='',dashboard=null,draft=null,working=null,selectedKey=null,busy=false
function message(text,error=false){$('message').textContent=text;$('message').setAttribute('role',error?'alert':'status')}
function node(tag,text,className){const value=document.createElement(tag);if(text!==undefined)value.textContent=text;if(className)value.className=className;return value}
function signedOut(){dashboard=null;draft=null;working=null;selectedKey=null;$('workspace').hidden=true;$('owner-tools').hidden=true;$('login-panel').hidden=false;$('editor').hidden=true;for(const id of ['draft-list','release-list','audit-list'])$(id).replaceChildren();$('catalogue-json').value='';$('login-form').elements.password.value='';$('login-form').elements.code.value=''}
async function api(route,body){
 const response=await fetch('api.php?r='+route,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
  headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)})
 let result;try{result=await response.json()}catch{throw Error('O servidor não confirmou a resposta. Atualize o painel.')}
 if(!response.ok||!result.ok){if(response.status===401)signedOut();throw Error(typeof result.error==='string'?result.error:'Operação não concluída.')}
 if(result.data?.csrf)csrf=result.data.csrf
 return result.data
}
async function operation(action){
 if(busy)return;busy=true;message('Aguarde, confirmando a operação…');document.querySelectorAll('button,input,textarea,select').forEach(element=>element.disabled=true)
 try{await action()}catch(error){message(error instanceof Error?error.message:'Operação não concluída.',true)}
 finally{if($('message').textContent==='Aguarde, confirmando a operação…')message('');busy=false;document.querySelectorAll('button,input,textarea,select').forEach(element=>element.disabled=false)}
}
function date(value){return new Date(Number(value)*1000).toLocaleString('pt-BR')}
function renderItems(){
 const query=$('item-search').value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
 const entries=working?.items??[]
 const visible=entries.filter(item=>(item.title+' '+item.key).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(query))
 $('item-list').replaceChildren(...visible.slice(0,200).map(item=>{const option=node('option',item.title+' · '+(item.year??'ano pendente'));option.value=item.key;return option}))
 $('item-summary').textContent=visible.length+' título(s) encontrado(s). A lista mostra até 200 por busca.'
}
function showDraft(value){
 draft=value;working=structuredClone(value.catalogue);selectedKey=null;$('editor').hidden=false;$('draft-caption').textContent=value.id?'RASCUNHO '+value.id+' · REVISÃO '+value.revision:'NOVO LOTE · AINDA NÃO SALVO'
 $('draft-title').value=value.title;$('catalogue-json').value=JSON.stringify(value.catalogue,null,2);$('item-search').value=''
 document.querySelectorAll('#review-checks input').forEach(input=>input.checked=false);renderItems();showItem(working.items[0])
}
function showItem(item){
 selectedKey=item?.key??null;$('item-key').value=item?.key??'';$('item-key').readOnly=Boolean(item)
 $('item-title').value=item?.title??'';$('item-year').value=item?.year??'';$('item-kind').value=item?.kind??'movie'
 $('item-category').value=item?.categories[0]??'fiction';$('item-source').value=item?.sourceUrl??'';$('item-poster').value=item?.posterUrl??'';$('item-attribution').value=item?.attribution??''
}
async function refresh(){
 dashboard=await api('dashboard')
 $('metric-drafts').textContent=dashboard.drafts.length;$('metric-releases').textContent=dashboard.releases.length
 $('metric-generation').textContent=dashboard.head.generation
 $('draft-list').replaceChildren(...dashboard.drafts.map(item=>{
  const row=node('li'),content=node('div');content.append(node('strong',item.title),node('small',item.item_count+' títulos · revisão '+item.revision+' · '+(item.review_id?'revisado':'aguardando revisão')))
  const button=node('button','Abrir rascunho');button.addEventListener('click',()=>void operation(async()=>{showDraft(await api('draft&id='+Number(item.id)));message('Rascunho carregado.')}));row.append(content,button);return row
 }))
 if(!dashboard.drafts.length)$('draft-list').append(node('li','Nenhum rascunho. Importe um catálogo JSON para começar.'))
 $('release-list').replaceChildren(...dashboard.releases.map(item=>{
  const row=node('li'),content=node('div'),active=Number(item.id)===dashboard.head.releaseId
  content.append(node('strong','Publicação '+item.id+(active?' · ativa':'')),node('small',item.item_count+' títulos · '+date(item.created_at)+' · '+item.actor))
  row.append(content)
  if(!active){const button=node('button','Reativar publicação '+item.id);button.addEventListener('click',()=>void operation(async()=>{
   const generation=dashboard.head.generation
   if(!confirm('Reativar a publicação '+item.id+'? A versão ativa do catálogo será alterada.'))return
   await api('rollback',{releaseId:Number(item.id),generation});await refresh();message('Publicação anterior reativada.')
  }));row.append(button)}
  return row
 }))
 if(!dashboard.releases.length)$('release-list').append(node('li','Nenhuma publicação. Rascunhos não ficam públicos automaticamente.'))
 $('audit-list').replaceChildren(...dashboard.audit.map(item=>node('li',date(item.created_at)+' · '+item.event_type+' · '+item.actor+(item.reference_id?' · #'+item.reference_id:''))))
}
async function enter(session){
 if(!session.authenticated){signedOut();return}
 $('login-panel').hidden=true;$('workspace').hidden=false;$('owner-tools').hidden=false;$('owner-name').textContent=session.username
 $('login-form').elements.password.value='';$('login-form').elements.code.value='';await refresh()
}
$('login-form').addEventListener('submit',event=>{event.preventDefault();void operation(async()=>{
 const form=event.currentTarget;const input={username:form.elements.username.value.trim(),password:form.elements.password.value,code:form.elements.code.value.trim()}
 const session=await api('login',input);await enter(session);message('Acesso confirmado.')
})})
$('logout').addEventListener('click',()=>void operation(async()=>{await api('logout',{});signedOut();message('Sessão encerrada.')}))
$('refresh').addEventListener('click',()=>void operation(async()=>{await refresh();message('Painel atualizado.')}))
$('new-draft').addEventListener('click',()=>{showDraft({id:null,revision:0,title:'Novo lote',digest:null,catalogue:{format:'sintonema.catalogue',version:1,mode:'supplement',items:[]}});$('item-key').focus()})
$('item-search').addEventListener('input',renderItems)
$('item-list').addEventListener('change',()=>{const item=working?.items.find(item=>item.key===$('item-list').value);if(item){showItem(item);$('item-summary').textContent=item.key+' · '+item.kind+' · Fonte: '+(item.sourceUrl??'registro local preservado')+' · '+item.attribution}})
$('new-item').addEventListener('click',()=>{showItem(null);$('item-key').focus()})
$('apply-item').addEventListener('click',()=>{
 try{
  if(!working)throw Error('Abra um rascunho.')
  const key=$('item-key').value.trim(),title=$('item-title').value.trim(),year=$('item-year').value.trim()
  if(!/^(local|tmdb|tvmaze):(movie|tv):[1-9][0-9]*$/.test(key)||!title)throw Error('Confira a identidade da fonte e o título.')
  if(year&&!/^[0-9]{4}$/.test(year))throw Error('Preencha um ano válido ou deixe o campo vazio.')
  if(!selectedKey&&working.items.some(item=>item.key===key))throw Error('Esta identidade já está no lote.')
  const old=working.items.find(item=>item.key===selectedKey)
  const categories=[$('item-category').value,...(old?.categories.slice(1)??[])].filter((value,index,array)=>array.indexOf(value)===index)
  const item={key,title,year:year?Number(year):null,kind:$('item-kind').value,categories,posterUrl:$('item-poster').value.trim()||null,sourceUrl:$('item-source').value.trim()||null,attribution:$('item-attribution').value.trim()}
  working.items=selectedKey?working.items.map(previous=>previous.key===selectedKey?item:previous):[...working.items,item]
  $('catalogue-json').value=JSON.stringify(working,null,2);renderItems();showItem(item);message('Ficha atualizada no editor. Salve as alterações para confirmar o rascunho.')
 }catch(error){message(error.message,true)}
})
$('remove-item').addEventListener('click',()=>{if(working&&selectedKey&&confirm('Retirar este título do lote? A biblioteca pessoal não será alterada.')){working.items=working.items.filter(item=>item.key!==selectedKey);$('catalogue-json').value=JSON.stringify(working,null,2);renderItems();showItem(working.items[0]);message('Título retirado do editor. Salve para confirmar.')}})
$('apply-json').addEventListener('click',()=>{try{const value=JSON.parse($('catalogue-json').value);if(!Array.isArray(value.items)||!value.items.every(item=>item&&typeof item.key==='string'&&typeof item.title==='string'&&Array.isArray(item.categories)))throw Error();working=value;renderItems();showItem(working.items[0]);message('Conteúdo carregado no editor. A validação completa ocorre ao salvar.')}catch{message('Confira o conteúdo JSON antes de aplicar ao editor.',true)}})
$('import-file').addEventListener('change',event=>{
 const file=event.target.files?.[0];event.target.value='';if(!file)return
 void operation(async()=>{if(file.size>4*1024*1024)throw Error('O arquivo deve ter até 4 MiB.');let catalogue
  try{catalogue=JSON.parse(await file.text())}catch{throw Error('Escolha um catálogo JSON válido.')}
  const created=await api('drafts/create',{title:file.name.slice(0,110)||'Novo lote',catalogue});await refresh();showDraft(created);message('Importação salva como rascunho. Confira as identidades e os direitos.')
 })
})
$('save-draft').addEventListener('click',()=>void operation(async()=>{
 if(!draft)throw Error('Abra um rascunho.');let catalogue
 try{catalogue=JSON.parse($('catalogue-json').value)}catch{throw Error('O conteúdo precisa ser JSON válido.')}
 const saved=draft.id?await api('drafts/update',{id:draft.id,revision:draft.revision,title:$('draft-title').value,catalogue}):await api('drafts/create',{title:$('draft-title').value,catalogue});await refresh();showDraft(saved);message('Alterações salvas. Revise esta versão antes de publicar.')
}))
$('review-draft').addEventListener('click',()=>void operation(async()=>{
 if(!draft?.id)throw Error('Salve o rascunho antes de revisar.');if($('catalogue-json').value!==JSON.stringify(draft.catalogue,null,2)||$('draft-title').value!==draft.title)throw Error('Salve as alterações antes de revisar.')
 const checks=Object.fromEntries([...document.querySelectorAll('#review-checks input')].map(input=>[input.name,input.checked]))
 await api('drafts/review',{id:draft.id,revision:draft.revision,digest:draft.digest,checks});await refresh();message('Revisão registrada para este conteúdo exato.')
}))
$('publish-draft').addEventListener('click',()=>void operation(async()=>{
 if(!draft?.id||!dashboard)throw Error('Salve e revise um rascunho antes de publicar.')
 if($('catalogue-json').value!==JSON.stringify(draft.catalogue,null,2)||$('draft-title').value!==draft.title)throw Error('Salve e revise as alterações antes de publicar.')
 const input={id:draft.id,revision:draft.revision,generation:dashboard.head.generation}
 if(!confirm('Publicar este catálogo revisado? Ele ficará disponível no endpoint público.'))return
 await api('publish',input);await refresh();message('Catálogo publicado. O aplicativo só o consultará após a integração correspondente.')
}))
$('revoke-sessions').addEventListener('click',()=>void operation(async()=>{
 if(!confirm('Encerrar todas as sessões administrativas, incluindo esta?'))return
 await api('sessions/revoke',{});signedOut();message('Todas as sessões foram encerradas.')
}))
void operation(async()=>{await enter(await api('session'))})
