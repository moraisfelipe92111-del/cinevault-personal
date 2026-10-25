<?php
declare(strict_types=1);
namespace Sintonema\Admin;

final class Http
{
    public function __construct(private readonly Auth $auth, private readonly Catalogue $catalogue, private readonly Config $config) {}
    private function csrf(array $session, array $headers): void
    {
        requireValue(($headers['origin']??'')===$this->config->origin &&
            isset($session['csrf']) && is_string($headers['x-csrf-token']??null) &&
            hash_equals($session['csrf'],$headers['x-csrf-token']), 'Reabra o painel para confirmar esta ação.',403);
    }
    public function dispatch(string $method, string $route, mixed $input, array &$session, array $headers, string $address, int $now): array
    {
        requireValue(in_array($method,['GET','POST'],true),'Método não permitido.',405);
        if ($route==='catalogue' && $method==='GET') { return ['data'=>$this->catalogue->publicDocument(),'public'=>true]; }
        if (!isset($session['csrf'])) { $session['csrf']=bin2hex(random_bytes(32)); }
        $owner=$this->auth->session($session['owner']??null,$now);
        if ($owner) { $session['owner']=$owner; } else { unset($session['owner']); }
        if ($method==='GET' && $route==='session') {
            return ['data'=>['authenticated'=>$owner!==null,'username'=>$owner['username']??null,'csrf'=>$session['csrf']]];
        }
        if ($method==='POST' && $route==='login') {
            $this->csrf($session,$headers);
            requireValue(exactObject($input,['username','password','code']) && is_string($input['username']) &&
                is_string($input['password']) && is_string($input['code']), 'Login ou código inválido.',401);
            $session['owner']=$this->auth->login($input['username'],$input['password'],$input['code'],$address,$now);
            $session['csrf']=bin2hex(random_bytes(32));
            return ['data'=>['authenticated'=>true,'username'=>$session['owner']['username'],'csrf'=>$session['csrf']],'rotate'=>true];
        }
        requireValue($owner!==null,'Entre com senha e segundo fator para continuar.',401);
        if ($method==='GET' && $route==='dashboard') { return ['data'=>$this->catalogue->dashboard()]; }
        if ($method==='GET' && $route==='draft') {
            requireValue(exactObject($input,['id']),'Referência inválida.');
            return ['data'=>$this->catalogue->draft(positive($input['id']))];
        }
        requireValue($method==='POST','Método não permitido.',405); $this->csrf($session,$headers);
        if ($route==='logout' || $route==='sessions/revoke') {
            requireValue($input===[],'Requisição inválida.');
            if ($route==='sessions/revoke') { $this->auth->revoke($owner['username'],$now); }
            $session=['csrf'=>bin2hex(random_bytes(32))];
            return ['data'=>['authenticated'=>false,'username'=>null,'csrf'=>$session['csrf']],'rotate'=>true];
        }
        if ($route==='drafts/create') {
            requireValue(exactObject($input,['title','catalogue']) && is_string($input['title']), 'Rascunho inválido.');
            return ['data'=>$this->catalogue->create($input['catalogue'],$input['title'],$owner['username'],$now)];
        }
        if ($route==='drafts/update') {
            requireValue(exactObject($input,['id','revision','title','catalogue']) && is_string($input['title']), 'Rascunho inválido.');
            return ['data'=>$this->catalogue->update(positive($input['id']),positive($input['revision']),$input['catalogue'],$input['title'],$owner['username'],$now)];
        }
        if ($route==='drafts/review') {
            requireValue(exactObject($input,['id','revision','digest','checks']) && is_string($input['digest']), 'Revisão inválida.');
            return ['data'=>$this->catalogue->review(positive($input['id']),positive($input['revision']),$input['digest'],$input['checks'],$owner['username'],$now)];
        }
        if ($route==='publish') {
            requireValue(exactObject($input,['id','revision','generation']), 'Publicação inválida.');
            return ['data'=>$this->catalogue->publish(positive($input['id']),positive($input['revision']),positive($input['generation'],true),$owner['username'],$now)];
        }
        if ($route==='rollback') {
            requireValue(exactObject($input,['releaseId','generation']), 'Reversão inválida.');
            return ['data'=>$this->catalogue->rollback(positive($input['releaseId']),positive($input['generation'],true),$owner['username'],$now)];
        }
        throw new Failure('Recurso não encontrado.',404);
    }
}
