<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') { http_response_code(404); exit; }
require dirname(__DIR__).'/bootstrap.php';
use Sintonema\Admin\{Auth,Catalogue,Config,Database};
use function Sintonema\Admin\{jsonText,requireValue};

try {
    $command=$argv[1]??'';
    requireValue(in_array($command,['key','migrate','owner','recover-owner','check'],true),'Comandos: key, migrate, owner, recover-owner, check.');
    if ($command==='key') { echo base64_encode(random_bytes(32)).PHP_EOL; exit; }
    $public=getenv('SINTONEMA_PUBLIC_DIR')?:dirname(__DIR__).'/public';
    $config=Config::load(dirname(__DIR__),$public); $db=new Database($config->connect());
    if ($command==='migrate') { $db->migrate(file_get_contents(dirname(__DIR__).'/schema.sql')); echo "Banco exclusivo inicializado.\n"; exit; }
    $db->assertReady();
    if ($command==='check') { echo jsonText(['schema'=>1,'php'=>PHP_VERSION,'ownerConfigured'=>(bool)$db->query('SELECT id FROM sn_owner WHERE id=1')]).PHP_EOL; exit; }
    // Credentials arrive through stdin, never command arguments, URL parameters, public files or repository secrets.
    $raw=stream_get_contents(STDIN,4096); $input=json_decode($raw,true,8,JSON_THROW_ON_ERROR);
    requireValue(is_array($input) && is_string($input['username']??null) && is_string($input['password']??null),'Envie username/password por stdin privado.');
    if ($command==='recover-owner') { requireValue(($input['confirm']??'')==='RECONFIGURAR PROPRIETARIO','Confirmação privada de recuperação ausente.'); }
    $setup=(new Auth($db,$config))->provision($input['username'],$input['password'],time(),$command==='recover-owner');
    echo jsonText($setup).PHP_EOL;
    fwrite(STDERR,"Guarde o segredo e os códigos de recuperação em local privado. Não os publique nem envie ao chat.\n");
} catch (Throwable $error) {
    fwrite(STDERR,$error instanceof \Sintonema\Admin\Failure ? $error->getMessage().PHP_EOL : "Operação não concluída. Confira configuração, extensões e banco privado.\n"); exit(1);
}
