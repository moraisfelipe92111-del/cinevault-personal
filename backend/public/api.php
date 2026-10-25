<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
ini_set('display_errors','0');

try {
    $private=getenv('SINTONEMA_PRIVATE_DIR') ?: dirname(__DIR__,2).'/sintonema-private';
    if (!is_file($private.'/bootstrap.php')) { throw new RuntimeException('private_directory_unavailable'); }
    require_once $private.'/bootstrap.php';
    $config=\Sintonema\Admin\Config::load($private,__DIR__);
    $expectedHost=parse_url($config->origin,PHP_URL_HOST).(parse_url($config->origin,PHP_URL_PORT) ? ':'.parse_url($config->origin,PHP_URL_PORT) : '');
    \Sintonema\Admin\requireValue(strtolower($_SERVER['HTTP_HOST']??'')===strtolower($expectedHost),'Endereço administrativo inválido.',400);
    $secure=($_SERVER['HTTPS']??'')==='on' || ($_SERVER['HTTPS']??'')==='1';
    \Sintonema\Admin\requireValue($secure || ($config->local && ($_SERVER['REMOTE_ADDR']??'')==='127.0.0.1'),'HTTPS é obrigatório.',503);
    $method=$_SERVER['REQUEST_METHOD']??''; $route=$_GET['r']??'';
    \Sintonema\Admin\requireValue(is_string($route) && (bool)preg_match('~^[a-z/]{1,40}$~D',$route),'Recurso não encontrado.',404);
    $public=$route==='catalogue' && $method==='GET';
    if (!$public) {
        $sessionDirectory=$private.'/sessions';
        \Sintonema\Admin\requireValue(is_dir($sessionDirectory) && !is_link($sessionDirectory) && (fileperms($sessionDirectory)&0077)===0,
            'Armazenamento de sessão indisponível.',503);
        ini_set('session.use_strict_mode','1'); ini_set('session.use_only_cookies','1'); ini_set('session.use_trans_sid','0');
        ini_set('session.gc_maxlifetime','28800'); ini_set('session.serialize_handler','php_serialize');
        session_save_path($sessionDirectory); session_name($config->local?'SINTONEMA_ADMIN':'__Host-SINTONEMA_ADMIN');
        session_set_cookie_params(['lifetime'=>0,'path'=>$config->path,'secure'=>!$config->local,'httponly'=>true,'samesite'=>'Strict']);
        \Sintonema\Admin\requireValue(session_start(),'Não foi possível abrir a sessão.',503);
    }
    $db=new \Sintonema\Admin\Database($config->connect()); $db->assertReady();
    $auth=new \Sintonema\Admin\Auth($db,$config);
    // Reject unauthenticated catalogue operations and cross-origin writes before reading/parsing their bodies.
    if (!$public && !in_array($route,['session','login'],true)) {
        \Sintonema\Admin\requireValue($auth->session($_SESSION['owner']??null,time())!==null,'Entre com senha e segundo fator para continuar.',401);
    }
    if (!$public && $method==='POST') {
        \Sintonema\Admin\requireValue(($_SERVER['HTTP_ORIGIN']??'')===$config->origin && isset($_SESSION['csrf']) &&
            hash_equals($_SESSION['csrf'],$_SERVER['HTTP_X_CSRF_TOKEN']??''),'Reabra o painel para confirmar esta ação.',403);
    }
    $legacy=json_decode(file_get_contents($private.'/resources/legacy-films.json'),true,64,JSON_THROW_ON_ERROR);
    $app=new \Sintonema\Admin\Http($auth,new \Sintonema\Admin\Catalogue($db,$legacy),$config);
    $input=[];
    if ($method==='POST') {
        \Sintonema\Admin\requireValue(strtolower(trim(explode(';',$_SERVER['CONTENT_TYPE']??'')[0]))==='application/json','Envie JSON para esta operação.',415);
        $limit=$route==='login'?2048:4*1024*1024+4096;
        \Sintonema\Admin\requireValue((int)($_SERVER['CONTENT_LENGTH']??0)<=$limit,'Requisição acima do limite.',413);
        $raw=file_get_contents('php://input',false,null,0,$limit+1);
        \Sintonema\Admin\requireValue(is_string($raw) && strlen($raw)<=$limit,'Requisição acima do limite.',413);
        try {
            $wire=json_decode($raw,false,64,JSON_THROW_ON_ERROR);
            if ($wire instanceof stdClass && isset($wire->catalogue) && $wire->catalogue instanceof stdClass && isset($wire->catalogue->items)) {
                \Sintonema\Admin\requireValue(is_array($wire->catalogue->items),'A lista de títulos precisa ser uma lista JSON.');
                foreach ($wire->catalogue->items as $item) {
                    if ($item instanceof stdClass && isset($item->categories)) {
                        \Sintonema\Admin\requireValue(is_array($item->categories),'Categorias precisam ser uma lista JSON.');
                    }
                }
            }
            unset($wire);
            $input=json_decode($raw,true,64,JSON_THROW_ON_ERROR);
        }
        catch (JsonException) { throw new \Sintonema\Admin\Failure('JSON inválido.'); }
    } elseif ($route==='draft') {
        $id=$_GET['id']??'';
        \Sintonema\Admin\requireValue(is_string($id) && (bool)preg_match('/^[1-9][0-9]{0,14}$/D',$id),'Referência inválida.');
        $input=['id'=>(int)$id];
    }
    $headers=['origin'=>$_SERVER['HTTP_ORIGIN']??'','x-csrf-token'=>$_SERVER['HTTP_X_CSRF_TOKEN']??''];
    $session=$public?[]:$_SESSION;
    $response=$app->dispatch($method,$route,$input,$session,$headers,$_SERVER['REMOTE_ADDR']??'',time());
    if (!$public) {
        if ($response['rotate']??false) { \Sintonema\Admin\requireValue(session_regenerate_id(true),'Não foi possível confirmar a sessão.',503); }
        $_SESSION=$session; session_write_close();
    }
    if ($response['public']??false) {
        $etag='"'.$response['data']['generation'].'-'.$response['data']['sha256'].'"';
        header('Cache-Control: public, max-age=60, must-revalidate'); header('ETag: '.$etag);
        if (($_SERVER['HTTP_IF_NONE_MATCH']??'')===$etag) { http_response_code(304); exit; }
    }
    echo \Sintonema\Admin\jsonText(['ok'=>true,'data'=>$response['data']]);
} catch (Throwable $error) {
    if (session_status()===PHP_SESSION_ACTIVE) { session_write_close(); }
    $known=$error instanceof \Sintonema\Admin\Failure;
    http_response_code($known?$error->status:503);
    // Never log request bodies, SQL parameters, passwords, OTP secrets or PDO messages.
    if (!$known) { error_log('Sintonema admin: request failed ('.get_class($error).')'); }
    echo json_encode(['ok'=>false,'error'=>$known?$error->getMessage():'Serviço administrativo indisponível. Tente novamente.'],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
}
