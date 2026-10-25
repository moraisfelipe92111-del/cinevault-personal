<?php
declare(strict_types=1);
require __DIR__.'/helpers.php';
use Sintonema\Admin\Auth;
use function Sintonema\Admin\jsonText;
$directory=getenv('SINTONEMA_TEST_PRIVATE_DIR')?:'';
if(!is_dir($directory)||!str_starts_with(basename($directory),'sintonema-http-'))throw new RuntimeException('Diretório sintético inválido.');
$config=testConfig(getenv('SINTONEMA_ADMIN_BASE_URL')?:'http://127.0.0.1:8800');$db=resetTestDatabase($config);
$password='Only-Fixture-HTTP-Password-44!';$setup=(new Auth($db,$config))->provision('felipe_teste',$password,time());
file_put_contents($directory.'/config.php',"<?php\nreturn ".var_export($config->values,true).";\n");chmod($directory.'/config.php',0600);
if(!is_dir($directory.'/sessions'))mkdir($directory.'/sessions',0700);chmod($directory.'/sessions',0700);
file_put_contents($directory.'/fixture.json',jsonText([...$setup,'password'=>$password]));chmod($directory.'/fixture.json',0600);
echo "Fixture HTTP sintética preparada.\n";
