<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/bootstrap.php';
use Sintonema\Admin\{Config,Database};

function testConfig(string $base='http://127.0.0.1:8800'): Config
{
    $dsn=getenv('SINTONEMA_TEST_DSN')?:''; $database=getenv('SINTONEMA_TEST_DATABASE')?:'';
    if (!preg_match('/^sintonema_test_[a-z0-9_]+$/D',$database) || !str_starts_with($dsn,'mysql:')) {
        throw new RuntimeException('Os testes exigem banco MySQL sintético sintonema_test_*.');
    }
    return new Config(['base_url'=>$base,'dsn'=>$dsn,'database_name'=>$database,
        'db_user'=>getenv('SINTONEMA_TEST_DB_USER')?:'root','db_password'=>getenv('SINTONEMA_TEST_DB_PASSWORD')?:'',
        'secret_key'=>base64_encode(str_repeat('f',32)),'allow_local_http'=>true]);
}
function resetTestDatabase(Config $config): Database
{
    $pdo=$config->connect();
    if (!str_starts_with((string)$pdo->query('SELECT DATABASE()')->fetchColumn(),'sintonema_test_')) { throw new RuntimeException('Banco de teste inválido.'); }
    $pdo->exec('SET FOREIGN_KEY_CHECKS=0');
    foreach ($pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) as $name) {
        if (!preg_match('/^[a-z_]+$/D',$name)) { throw new RuntimeException('Tabela de teste inválida.'); }
        $pdo->exec('DROP TABLE `'.$name.'`');
    }
    $pdo->exec('SET FOREIGN_KEY_CHECKS=1'); $db=new Database($pdo);$db->migrate(file_get_contents(dirname(__DIR__).'/schema.sql'));return $db;
}
function sampleCatalogue(string $title='História sintética de teste'): array
{
    return ['format'=>'sintonema.catalogue','version'=>1,'mode'=>'supplement','items'=>[
        ['key'=>'tmdb:movie:999999999','title'=>$title,'year'=>2026,'kind'=>'movie','categories'=>['fiction'],
            'posterUrl'=>null,'sourceUrl'=>'https://www.themoviedb.org/movie/999999999','attribution'=>'Dados sintéticos exclusivos dos testes'],
    ]];
}
