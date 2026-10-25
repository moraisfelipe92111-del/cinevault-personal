<?php
declare(strict_types=1);
require __DIR__.'/helpers.php';
use Sintonema\Admin\{Auth,Catalogue,Config,Database,Failure,Http,Totp};
use function Sintonema\Admin\jsonText;

$cases=0;$assertions=0;
function check(bool $condition,string $message='verificação'): void { global $assertions; $assertions++;if(!$condition)throw new RuntimeException($message); }
function fails(callable $action,?int $status=null): void {
    try{$action();}catch(Throwable $error){check($status===null || ($error instanceof Failure && $error->status===$status),'falha esperada');return;}
    throw new RuntimeException('A operação deveria falhar.');
}
function testCase(string $name,callable $action): void { global $cases;$action();$cases++;echo "OK ".$name.PHP_EOL; }

$config=testConfig();$db=resetTestDatabase($config);$legacy=json_decode(file_get_contents(dirname(__DIR__).'/resources/legacy-films.json'),true);
$catalogue=new Catalogue($db,$legacy);$auth=new Auth($db,$config);$now=1800000000;$password='Only-Fixture-Password-44!';
$setup=$auth->provision('felipe_teste',$password,$now);$checks=['identity'=>true,'metadataRights'=>true,'imageRights'=>true];

testCase('configuração privada, HTTPS e banco dedicado',function()use($config){
    foreach(['http://example.com/admin','https://user@example.com/admin','https://example.com/admin?secret=x','https://example.com/../admin'] as $url)
        fails(fn()=>new Config([...$config->values,'base_url'=>$url,'allow_local_http'=>false]),503);
    fails(fn()=>new Config([...$config->values,'database_name'=>'outro_projeto']),503);
    fails(fn()=>new Config([...$config->values,'secret_key'=>'placeholder']),503);
    fails(fn()=>Config::load(dirname(__DIR__).'/public',dirname(__DIR__).'/public'),503);
});
testCase('migração explícita recusa banco ocupado e transações de terceiros',function()use($db){
    fails(fn()=>$db->migrate(file_get_contents(dirname(__DIR__).'/schema.sql')),409);
    $db->pdo->beginTransaction();fails(fn()=>$db->transaction(fn()=>1),409);check($db->pdo->inTransaction());$db->pdo->rollBack();
    $db->execute('CREATE TABLE unrelated (id INT) ENGINE=InnoDB');fails(fn()=>$db->assertReady(),503);$db->execute('DROP TABLE unrelated');$db->assertReady();
});
testCase('TOTP confere os seis vetores SHA-1 do RFC 6238',function(){
    foreach([[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']] as [$time,$expected])
        check(Totp::at('12345678901234567890',intdiv($time,30),8)===$expected);
    check(Totp::decode(Totp::encode('12345678901234567890'))==='12345678901234567890');
});
testCase('senha, segredo e códigos não são armazenados como texto recuperável sem a chave privada',function()use($db,$setup,$password){
    $owner=$db->query('SELECT * FROM sn_owner WHERE id=1')[0];
    check(str_starts_with($owner['password_hash'],'$argon2id$'));check(!str_contains(jsonText($owner),$password));
    check(!str_contains($owner['totp_secret'],$setup['totpSecret']));check(count($db->query('SELECT * FROM sn_recovery_codes'))===10);
    foreach($db->query('SELECT * FROM sn_recovery_codes') as $row)check(!in_array($row['code_hash'],$setup['recoveryCodes'],true));
});
testCase('limite mínimo de senha conta caracteres Unicode, não somente bytes',function()use($auth,$now){
    fails(fn()=>$auth->provision('teste','😀😀😀😀',$now),422);
    fails(fn()=>$auth->provision('teste',"password\0long-enough",$now),422);
});
testCase('segundo fator obrigatório e código aceito somente uma vez',function()use($auth,$setup,$password,$now){
    fails(fn()=>$auth->login('felipe_teste',$password,'','ip-required',$now),401);
    $code=Totp::at(Totp::decode($setup['totpSecret']),intdiv($now,30));
    $owner=$auth->login('felipe_teste',$password,$code,'ip-mfa',$now);check($owner['id']===1);
    fails(fn()=>$auth->login('felipe_teste',$password,$code,'ip-mfa-replay',$now),401);
    fails(fn()=>$auth->login('felipe_teste',$password,Totp::at(Totp::decode($setup['totpSecret']),intdiv($now,30)-3),'ip-stale',$now),401);
});
testCase('códigos de recuperação são de uso único e exigem a senha',function()use($auth,$setup,$password,$now){
    fails(fn()=>$auth->login('felipe_teste','wrong',$setup['recoveryCodes'][0],'ip-recovery-wrong',$now),401);
    $session=$auth->login('felipe_teste',$password,$setup['recoveryCodes'][0],'ip-recovery',$now);check($session['id']===1);
    fails(fn()=>$auth->login('felipe_teste',$password,$setup['recoveryCodes'][0],'ip-recovery-replay',$now),401);
});
testCase('limite de tentativas é durável, tem prazo e não depende de cookie',function()use($auth,$now){
    for($i=0;$i<5;$i++)fails(fn()=>$auth->login('missing','wrong','000000','ip-limited',$now),401);
    fails(fn()=>$auth->login('missing','wrong','000000','ip-limited',$now),429);
    fails(fn()=>$auth->login('missing','wrong','000000','ip-limited',$now+901),401);
});
testCase('sessões expiram por inatividade, prazo total e revogação',function()use($auth,$setup,$password,$now){
    $session=$auth->login('felipe_teste',$password,$setup['recoveryCodes'][1],'ip-sessions',$now);
    check($auth->session($session,$now+100)!==null);check($auth->session($session,$now+1201)===null);
    check($auth->session([...$session,'lastSeen'=>$now+28801],$now+28801)===null);
    check($auth->session([...$session,'issuedAt'=>$now+50],$now)===null);
    $auth->revoke('felipe_teste',$now);check($auth->session($session,$now)===null);
});
testCase('bloqueio MySQL serializa tentativas sem consumir código após timeout',function()use($config,$db,$setup,$password,$now){
    $other=new Database($config->connect());$other->pdo->exec('SET SESSION innodb_lock_wait_timeout=1');
    $db->pdo->beginTransaction();$db->query('SELECT id FROM sn_owner WHERE id=1 FOR UPDATE');
    fails(fn()=>(new Auth($other,$config))->login('felipe_teste',$password,$setup['recoveryCodes'][2],'ip-lock',$now));
    check(!$other->pdo->inTransaction());check($db->pdo->inTransaction());$db->pdo->rollBack();
    check((new Auth($other,$config))->login('felipe_teste',$password,$setup['recoveryCodes'][2],'ip-lock',$now)['id']===1);
});
testCase('registro dos 1.000 filmes corresponde ao catálogo e impede trocar sua identidade',function()use($catalogue,$legacy){
    $films=json_decode(file_get_contents(dirname(__DIR__,2).'/src/films.json'),true);$links=json_decode(file_get_contents(dirname(__DIR__,2).'/src/movieTmdbIds.json'),true);check(count($legacy)===1000);
    foreach($films as $film)check($legacy[(string)$film['id']]===['title'=>$film['title'],'year'=>$film['year'],'aliases'=>isset($links[(string)$film['id']])?['tmdb:movie:'.$links[(string)$film['id']]]:[]]);
    check(array_sum(array_map(fn($entry)=>count($entry['aliases']),$legacy))===983);
    $film=$films[0];$item=sampleCatalogue()['items'][0];$item['key']='local:movie:'.$film['id'];$item['title']=$film['title'];$item['year']=$film['year'];$item['sourceUrl']=null;
    $input=sampleCatalogue();$input['items']=[$item];check($catalogue->validate($input)['items'][0]['key']===$item['key']);
    $input['items'][0]['title']='Outra obra';fails(fn()=>$catalogue->validate($input));
    $id=array_key_first($links);$duplicate=sampleCatalogue();$duplicate['items'][0]['key']='tmdb:movie:'.$links[$id];$duplicate['items'][0]['sourceUrl']='https://www.themoviedb.org/movie/'.$links[$id];fails(fn()=>$catalogue->validate($duplicate));
});
testCase('catálogo recusa dados privados, duplicação, fonte trocada, URLs perigosas e versões futuras',function()use($catalogue){
    $mutations=[fn($v)=>[...$v,'version'=>2],fn($v)=>[...$v,'favorites'=>[1]],fn($v)=>[...$v,'items'=>[]],fn($v)=>[...$v,'items'=>[$v['items'][0],$v['items'][0]]]];
    foreach($mutations as $mutate)fails(fn()=>$catalogue->validate($mutate(sampleCatalogue())));
    foreach([['key','tmdb:movie:042'],['posterUrl','javascript:alert(1)'],['posterUrl','https://image.tmdb.org/t/p/w500/test.jpg?secret=x'],['sourceUrl','https://example.com/'],['title','<script>bad</script>'],['year',INF],['categories',['future']]] as [$key,$value]){
        $input=sampleCatalogue();$input['items'][0][$key]=$value;fails(fn()=>$catalogue->validate($input));
    }
    $input=sampleCatalogue();$input['items'][0]['key']='tvmaze:tv:169';$input['items'][0]['kind']='series';$input['items'][0]['sourceUrl']='https://www.tvmaze.com/shows/169/breaking-bad';
    check($catalogue->validate($input)['items'][0]['key']==='tvmaze:tv:169');
});
$draft=$catalogue->create(sampleCatalogue(),'Lote sintético','felipe_teste',$now);
testCase('preparação do lote preserva os 1.000 filmes e oito identidades, sem dados pessoais ou publicação',function()use($catalogue,$legacy){
    $file=sys_get_temp_dir().'/sintonema-candidate-'.bin2hex(random_bytes(8)).'.json';
    $process=proc_open(['node',dirname(__DIR__,2).'/scripts/prepare-admin-catalogue.mjs',$file],[1=>['pipe','w'],2=>['pipe','w']],$pipes);
    $stdout=stream_get_contents($pipes[1]);$stderr=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);
    check(proc_close($process)===0,'preparação do lote: '.$stderr);check(str_contains($stdout,'1008 candidatos'));
    try{$value=json_decode(file_get_contents($file),true);$validated=$catalogue->validate($value);check(count($validated['items'])===1008);
        foreach($validated['items'] as $item){check(!isset($item['favorites'],$item['ratings'],$item['watched']));if(str_starts_with($item['key'],'local:movie:'))check(isset($legacy[substr($item['key'],12)]));}
        fails(fn()=>$catalogue->publicDocument(),404);
    }finally{if(is_file($file))unlink($file);}
});
testCase('importação é rascunho e não publica sem revisão vinculada ao digest',function()use($catalogue,$draft,$checks,$now){
    fails(fn()=>$catalogue->publicDocument(),404);fails(fn()=>$catalogue->publish($draft['id'],1,0,'felipe_teste',$now),409);
    fails(fn()=>$catalogue->review($draft['id'],1,$draft['digest'],[...$checks,'metadataRights'=>false],'felipe_teste',$now));
    fails(fn()=>$catalogue->review($draft['id'],1,str_repeat('0',64),$checks,'felipe_teste',$now),409);
    $catalogue->review($draft['id'],1,$draft['digest'],$checks,'felipe_teste',$now);
    $public=$catalogue->publish($draft['id'],1,0,'felipe_teste',$now);check($public['generation']===1);
    check($public['sha256']===hash('sha256',$public['content']));check(!str_contains(jsonText($public),'password_hash'));
});
testCase('edição invalida revisão; no-op e tentativas antigas não sobrescrevem estado novo',function()use($catalogue,$draft,$checks,$now){
    check($catalogue->update($draft['id'],1,sampleCatalogue(),'Lote sintético','felipe_teste',$now)['revision']===1);
    $next=$catalogue->update($draft['id'],1,sampleCatalogue('Segunda história sintética'),'Lote sintético','felipe_teste',$now);
    check($next['revision']===2);fails(fn()=>$catalogue->update($draft['id'],1,sampleCatalogue(),'old','felipe_teste',$now),409);
    fails(fn()=>$catalogue->publish($draft['id'],2,1,'felipe_teste',$now),409);
    $catalogue->review($draft['id'],2,$next['digest'],$checks,'felipe_teste',$now);
    fails(fn()=>$catalogue->publish($draft['id'],2,0,'felipe_teste',$now),409);
    check($catalogue->publish($draft['id'],2,1,'felipe_teste',$now)['generation']===2);
});
testCase('publicações ficam preservadas e reversão muda somente o apontador com geração crescente',function()use($catalogue,$now){
    $first=$catalogue->rollback(1,2,'felipe_teste',$now);check($first['generation']===3);check($first['releaseId']===1);
    check(json_decode($first['content'],true)['items'][0]['title']==='História sintética de teste');
    check($catalogue->rollback(1,3,'felipe_teste',$now)['generation']===3);
    check($catalogue->rollback(2,3,'felipe_teste',$now)['generation']===4);
});
testCase('publicação corrompida não é aceita nem substituída por catálogo vazio',function()use($db,$catalogue,$now){
    $saved=$db->query('SELECT payload FROM sn_releases WHERE id=1')[0]['payload'];
    $db->execute('UPDATE sn_releases SET payload=? WHERE id=1',['changed']);fails(fn()=>$catalogue->rollback(1,4,'felipe_teste',$now),503);
    check($catalogue->publicDocument()['releaseId']===2);$db->execute('UPDATE sn_releases SET payload=? WHERE id=1',[$saved]);
});
testCase('erro depois da inserção da publicação reverte conteúdo, apontador e auditoria',function()use($config,$catalogue,$legacy,$checks,$now){
    $draft=$catalogue->create(sampleCatalogue('Falha sintética'),'Falha','felipe_teste',$now);$catalogue->review($draft['id'],1,$draft['digest'],$checks,'felipe_teste',$now);
    $pdo=new class($config->values['dsn'],$config->values['db_user'],$config->values['db_password']) extends PDO {
        public ?Closure $observe=null;
        public function prepare(string $query,array $options=[]):PDOStatement|false { if(str_starts_with($query,'INSERT INTO sn_audit')){if($this->observe)($this->observe)();throw new RuntimeException('synthetic private error');}return parent::prepare($query,$options); }
    };
    $observer=new Catalogue(new Database($config->connect()),$legacy);
    $pdo->observe=function()use($observer){check($observer->publicDocument()['generation']===4);check(count($observer->dashboard()['releases'])===2);};
    $fault=new Catalogue(new Database($pdo),$legacy);fails(fn()=>$fault->publish($draft['id'],1,4,'felipe_teste',$now));
    check($catalogue->publicDocument()['generation']===4);check(count($catalogue->dashboard()['releases'])===2);
});
testCase('confirmação perdida após COMMIT é recuperável pela leitura sem publicação duplicada',function()use($config,$catalogue,$legacy,$checks,$now){
    $draft=$catalogue->create(sampleCatalogue('Confirmação perdida sintética'),'Confirmação','felipe_teste',$now);$catalogue->review($draft['id'],1,$draft['digest'],$checks,'felipe_teste',$now);
    $pdo=new class($config->values['dsn'],$config->values['db_user'],$config->values['db_password']) extends PDO {
        public function commit():bool {parent::commit();throw new RuntimeException('synthetic lost acknowledgement');}
    };
    fails(fn()=>(new Catalogue(new Database($pdo),$legacy))->publish($draft['id'],1,4,'felipe_teste',$now));
    check(!$pdo->inTransaction());check($catalogue->publicDocument()['generation']===5);check(count($catalogue->dashboard()['releases'])===3);
    fails(fn()=>$catalogue->publish($draft['id'],1,4,'felipe_teste',$now),409);check(count($catalogue->dashboard()['releases'])===3);
});
testCase('autorização, CSRF e origem são verificados no servidor para todas as gravações',function()use($auth,$catalogue,$config,$setup,$password,$now){
    $http=new Http($auth,$catalogue,$config);$session=[];$headers=['origin'=>$config->origin];
    $state=$http->dispatch('GET','session',[],$session,$headers,'ip-http',$now)['data'];check($state['authenticated']===false);
    foreach(['dashboard','draft'] as $route)fails(function()use($http,$route,&$session,$headers,$now){$http->dispatch('GET',$route,[],$session,$headers,'ip-http',$now);},401);
    foreach(['drafts/create','drafts/update','drafts/review','publish','rollback','sessions/revoke'] as $route)
        fails(function()use($http,$route,&$session,$headers,$now){$http->dispatch('POST',$route,[],$session,$headers,'ip-http',$now);},401);
    fails(function()use($http,&$session,$headers,$now){$http->dispatch('POST','login',[],$session,$headers,'ip-http',$now);},403);
    $headers['x-csrf-token']=$state['csrf'];$input=['username'=>'felipe_teste','password'=>$password,'code'=>$setup['recoveryCodes'][3]];
    $logged=$http->dispatch('POST','login',$input,$session,$headers,'ip-http',$now);check($logged['rotate']===true);check($session['csrf']!==$state['csrf']);
    fails(function()use($http,&$session,$headers,$now){$http->dispatch('POST','logout',[],$session,$headers,'ip-http',$now);},403);
    $headers['x-csrf-token']=$session['csrf'];$headers['origin']='https://attacker.invalid';
    fails(function()use($http,&$session,$headers,$now){$http->dispatch('POST','logout',[],$session,$headers,'ip-http',$now);},403);
    $headers['origin']=$config->origin;$http->dispatch('POST','logout',[],$session,$headers,'ip-http',$now);check(!isset($session['owner']));
});
testCase('reconfiguração privada revoga sessões e substitui os fatores antigos',function()use($auth,$setup,$password,$now){
    $session=$auth->login('felipe_teste',$password,$setup['recoveryCodes'][4],'ip-before-recovery',$now);
    fails(fn()=>$auth->provision('felipe_teste',$password,$now),409);
    $next=$auth->provision('felipe_teste',$password,$now,true);check($next['totpSecret']!==$setup['totpSecret']);check($auth->session($session,$now)===null);
    fails(fn()=>$auth->login('felipe_teste',$password,$setup['recoveryCodes'][5],'ip-after-recovery',$now),401);
});
echo "RESULT ".jsonText(['cases'=>$cases,'assertions'=>$assertions,'database'=>'real_mysql_compatible','passed'=>true]).PHP_EOL;
