<?php
declare(strict_types=1);
namespace Sintonema\Admin;

use PDO;
use RuntimeException;
use Throwable;

final class Failure extends RuntimeException
{
    public function __construct(string $message, public readonly int $status = 422) { parent::__construct($message); }
}

function requireValue(bool $ok, string $message, int $status = 422): void
{
    if (!$ok) { throw new Failure($message, $status); }
}

function jsonText(mixed $value): string
{
    return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function exactObject(mixed $value, array $keys): bool
{
    if (!is_array($value) || array_is_list($value)) { return false; }
    $actual = array_keys($value); sort($actual); sort($keys);
    return $actual === $keys;
}

function positive(mixed $value, bool $allowZero = false): int
{
    requireValue(is_int($value) && $value >= ($allowZero ? 0 : 1) && $value < 9007199254740991, 'Referência inválida.');
    return $value;
}

final class Config
{
    public readonly string $origin;
    public readonly string $path;
    public readonly string $key;
    public readonly bool $local;
    public function __construct(public readonly array $values)
    {
        $url = $values['base_url'] ?? '';
        requireValue(is_string($url) && strlen($url) < 512, 'Configuração indisponível.', 503);
        $parts = parse_url($url);
        requireValue(is_array($parts) && isset($parts['scheme'], $parts['host']) &&
            !isset($parts['user']) && !isset($parts['pass']) && !isset($parts['query']) && !isset($parts['fragment']), 'Configuração indisponível.', 503);
        $this->local = ($values['allow_local_http'] ?? false) === true &&
            $parts['scheme'] === 'http' && $parts['host'] === '127.0.0.1';
        requireValue($parts['scheme'] === 'https' || $this->local, 'HTTPS é obrigatório.', 503);
        $this->origin = $parts['scheme'].'://'.$parts['host'].(isset($parts['port']) ? ':'.$parts['port'] : '');
        $this->path = rtrim($parts['path'] ?? '', '/').'/';
        requireValue((bool)preg_match('~^/(?:[a-zA-Z0-9_-]+/)*$~D', $this->path), 'Caminho administrativo inválido.', 503);
        requireValue($this->local || $this->path==='/', 'Use a raiz de um subdomínio exclusivo para o painel.', 503);
        $key = base64_decode($values['secret_key'] ?? '', true);
        requireValue(is_string($key) && strlen($key) === 32, 'Chave privada indisponível.', 503);
        $this->key = $key;
        requireValue(is_string($values['database_name'] ?? null) &&
            (bool)preg_match('/(?:^|_)sintonema(?:_|$)/D', $values['database_name']), 'Use um banco exclusivo do Sintonema.', 503);
        requireValue(str_starts_with($values['dsn'] ?? '', 'mysql:'), 'Banco MySQL indisponível.', 503);
    }
    public static function load(string $directory, string $documentRoot): self
    {
        $private = realpath($directory); $web = realpath($documentRoot);
        requireValue($private !== false && $web !== false && $private !== $web &&
            !str_starts_with($private, $web.DIRECTORY_SEPARATOR) && !preg_match('~/(?:public_html|htdocs)(?:/|$)~',$private),
            'A configuração privada deve ficar fora da pasta pública.', 503);
        $file = $private.'/config.php';
        requireValue(is_file($file) && !is_link($file) && (fileperms($file) & 0077) === 0, 'Configuração privada indisponível.', 503);
        $values = require $file;
        requireValue(is_array($values), 'Configuração privada indisponível.', 503);
        return new self($values);
    }
    public function connect(): PDO
    {
        requireValue(PHP_VERSION_ID >= 80300 && extension_loaded('pdo_mysql') && extension_loaded('sodium') &&
            defined('PASSWORD_ARGON2ID'), 'PHP ou extensões incompatíveis.', 503);
        $pdo = new PDO($this->values['dsn'], $this->values['db_user'] ?? '', $this->values['db_password'] ?? '', [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        requireValue($pdo->query('SELECT DATABASE()')->fetchColumn() === $this->values['database_name'], 'Banco de dados inesperado.', 503);
        $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
        return $pdo;
    }
}

final class Database
{
    public const TABLES = ['sn_audit','sn_drafts','sn_head','sn_login_limits','sn_meta','sn_owner','sn_recovery_codes','sn_releases','sn_reviews'];
    public function __construct(public readonly PDO $pdo) {}
    public function assertReady(): void
    {
        $tables = $this->pdo->query('SELECT TABLE_NAME, TABLE_TYPE, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')->fetchAll();
        $names = array_column($tables, 'TABLE_NAME'); sort($names);
        requireValue($names === self::TABLES, 'Banco administrativo incompleto ou inesperado.', 503);
        foreach ($tables as $row) { requireValue($row['TABLE_TYPE'] === 'BASE TABLE' && $row['ENGINE'] === 'InnoDB', 'Estrutura administrativa inesperada.', 503); }
        requireValue((int)$this->pdo->query('SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()')->fetchColumn() === 0,
            'Estrutura administrativa inesperada.', 503);
        $version=$this->pdo->query('SELECT schema_version FROM sn_meta WHERE id = 1')->fetchColumn();
        requireValue($version===1 || $version==='1', 'Versão administrativa incompatível.', 503);
    }
    public function migrate(string $schema): void
    {
        requireValue(!$this->pdo->inTransaction(), 'Outra transação está ativa.', 409);
        requireValue((int)$this->pdo->query('SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')->fetchColumn() === 0,
            'A instalação inicial exige um banco exclusivo vazio.', 409);
        // MySQL DDL commits implicitly. An interrupted installation is refused, never repaired by opening the website.
        foreach (explode(';', $schema) as $statement) { if (trim($statement) !== '') { $this->pdo->exec($statement); } }
        $this->assertReady();
    }
    public function transaction(callable $operation): mixed
    {
        requireValue(!$this->pdo->inTransaction(), 'Outra transação está ativa.', 409);
        $this->pdo->beginTransaction();
        try { $result = $operation(); $this->pdo->commit(); return $result; }
        catch (Throwable $failure) {
            try { if ($this->pdo->inTransaction()) { $this->pdo->rollBack(); } } catch (Throwable) { /* Preserve the primary failure. */ }
            throw $failure;
        }
    }
    public function query(string $sql, array $parameters = []): array
    {
        $statement = $this->pdo->prepare($sql); $statement->execute($parameters); return $statement->fetchAll();
    }
    public function execute(string $sql, array $parameters = []): int
    {
        $statement = $this->pdo->prepare($sql); $statement->execute($parameters); return $statement->rowCount();
    }
    public function audit(string $event, string $actor, ?int $reference, int $now): void
    {
        $this->execute('INSERT INTO sn_audit (event_type, actor, reference_id, created_at) VALUES (?, ?, ?, ?)', [$event,$actor,$reference,$now]);
    }
}
