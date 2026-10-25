<?php
declare(strict_types=1);
// Copy to the private directory as config.php, chmod 600; never place it under public_html or commit it.
return [
    'base_url' => 'https://painel.SEU-DOMINIO',
    'dsn' => 'mysql:host=localhost;dbname=PREFIXO_sintonema;charset=utf8mb4',
    'database_name' => 'PREFIXO_sintonema',
    'db_user' => 'USUARIO_EXCLUSIVO',
    'db_password' => 'CONFIGURAR_PRIVADAMENTE',
    'secret_key' => 'GERAR_CHAVE_PRIVADA_BASE64_DE_32_BYTES',
    'allow_local_http' => false,
];
