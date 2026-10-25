<?php
declare(strict_types=1);
namespace Sintonema\Admin;

final class Auth
{
    public function __construct(private readonly Database $db, private readonly Config $config) {}
    private function seal(string $value): string
    {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return base64_encode($nonce.sodium_crypto_secretbox($value, $nonce, $this->config->key));
    }
    private function unseal(string $value): string
    {
        $bytes = base64_decode($value, true);
        requireValue(is_string($bytes) && strlen($bytes) > 40, 'Segundo fator indisponível.', 503);
        $raw = sodium_crypto_secretbox_open(substr($bytes,24), substr($bytes,0,24), $this->config->key);
        requireValue(is_string($raw), 'Segundo fator indisponível.', 503);
        return $raw;
    }
    private function codeHash(string $code): string { return hash_hmac('sha256', 'recovery:'.$code, $this->config->key); }
    public function provision(string $username, string $password, int $now, bool $replace = false): array
    {
        requireValue((bool)preg_match('/^[a-z0-9._-]{3,64}$/D', $username) && strlen($password) <= 512 &&
            preg_match_all('/./us',$password)>=14 && !str_contains($password,"\0"),
            'Use um login de 3–64 caracteres e uma senha de pelo menos 14 caracteres.');
        $secret = Totp::encode(random_bytes(20)); $codes = [];
        for ($i=0; $i<10; $i++) { $codes[] = bin2hex(random_bytes(10)); }
        $passwordHash = password_hash($password, PASSWORD_ARGON2ID, ['memory_cost'=>65536,'time_cost'=>3,'threads'=>1]);
        $this->db->transaction(function () use ($username,$passwordHash,$secret,$codes,$now,$replace): void {
            $owner = $this->db->query('SELECT id, session_epoch FROM sn_owner WHERE id = 1 FOR UPDATE');
            requireValue($replace || !$owner, 'O proprietário já foi configurado.', 409);
            $epoch = $owner ? (int)$owner[0]['session_epoch']+1 : 1;
            if ($owner) {
                $this->db->execute('UPDATE sn_owner SET username=?, password_hash=?, totp_secret=?, last_totp_step=-1, session_epoch=?, active=1 WHERE id=1',
                    [$username,$passwordHash,$this->seal($secret),$epoch]);
                $this->db->execute('DELETE FROM sn_recovery_codes');
            } else {
                $this->db->execute('INSERT INTO sn_owner (id,username,password_hash,totp_secret,last_totp_step,session_epoch,active) VALUES (1,?,?,?,-1,1,1)',
                    [$username,$passwordHash,$this->seal($secret)]);
            }
            foreach ($codes as $code) { $this->db->execute('INSERT INTO sn_recovery_codes (code_hash,used_at) VALUES (?,NULL)', [$this->codeHash($code)]); }
            $this->db->audit($replace?'owner_recovered':'owner_provisioned',$username,1,$now);
        });
        return ['username'=>$username,'totpSecret'=>$secret,'recoveryCodes'=>$codes,
            'authenticatorUri'=>'otpauth://totp/'.rawurlencode('Sintonema:'.$username).'?secret='.$secret.'&issuer=Sintonema&algorithm=SHA1&digits=6&period=30'];
    }
    private function limit(string $bucket, int $now): array
    {
        $this->db->execute('INSERT IGNORE INTO sn_login_limits (bucket,failures,reset_at) VALUES (?,0,?)', [$bucket,$now+900]);
        $row = $this->db->query('SELECT failures,reset_at FROM sn_login_limits WHERE bucket=? FOR UPDATE', [$bucket])[0];
        if ((int)$row['reset_at'] <= $now) {
            $this->db->execute('UPDATE sn_login_limits SET failures=0,reset_at=? WHERE bucket=?', [$now+900,$bucket]);
            return ['failures'=>0,'reset_at'=>$now+900];
        }
        return $row;
    }
    public function login(string $username, string $password, string $code, string $address, int $now): array
    {
        requireValue(strlen($username)<=64 && strlen($password)<=512 && strlen($code)<=32, 'Login ou código inválido.', 401);
        $ipBucket = hash_hmac('sha256','login-ip:'.$address,$this->config->key);
        $globalBucket = hash_hmac('sha256','login-global',$this->config->key);
        $result = $this->db->transaction(function () use ($username,$password,$code,$now,$ipBucket,$globalBucket): array {
            $this->db->execute('DELETE FROM sn_login_limits WHERE reset_at <= ?', [$now]);
            $global = $this->limit($globalBucket,$now);
            if ((int)$global['failures']>=100) { return ['limited'=>true]; }
            if ((int)$this->db->pdo->query('SELECT COUNT(*) FROM sn_login_limits')->fetchColumn()>=5000 &&
                !$this->db->query('SELECT bucket FROM sn_login_limits WHERE bucket=?',[$ipBucket])) { return ['limited'=>true]; }
            $ip = $this->limit($ipBucket,$now);
            if ((int)$ip['failures']>=5 || (int)$global['failures']>=100) { return ['limited'=>true]; }
            $rows = $this->db->query('SELECT * FROM sn_owner WHERE id=1 FOR UPDATE'); $owner = $rows[0] ?? null;
            $validPassword = $owner && (int)$owner['active']===1 && hash_equals($owner['username'],$username) && password_verify($password,$owner['password_hash']);
            $step = null; $recovery = null;
            if ($validPassword) {
                $step = Totp::match($this->unseal($owner['totp_secret']),$code,$now,(int)$owner['last_totp_step']);
                if ($step === null && (bool)preg_match('/^[a-f0-9]{20}$/D',$code)) {
                    $recovery = $this->db->query('SELECT code_hash FROM sn_recovery_codes WHERE code_hash=? AND used_at IS NULL FOR UPDATE', [$this->codeHash($code)])[0] ?? null;
                }
            }
            if (!$validPassword || ($step === null && !$recovery)) {
                foreach ([$ipBucket,$globalBucket] as $bucket) { $this->db->execute('UPDATE sn_login_limits SET failures=failures+1 WHERE bucket=?', [$bucket]); }
                return ['invalid'=>true];
            }
            if ($step !== null) { $this->db->execute('UPDATE sn_owner SET last_totp_step=? WHERE id=1', [$step]); }
            if ($recovery) { $this->db->execute('UPDATE sn_recovery_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL', [$now,$recovery['code_hash']]); }
            $this->db->execute('DELETE FROM sn_login_limits WHERE bucket=?', [$ipBucket]);
            $this->db->audit($recovery?'login_recovery_code':'login_mfa',$owner['username'],1,$now);
            return ['id'=>1,'username'=>$owner['username'],'epoch'=>(int)$owner['session_epoch'],'issuedAt'=>$now,'lastSeen'=>$now];
        });
        requireValue(!isset($result['limited']), 'Muitas tentativas. Aguarde 15 minutos.', 429);
        requireValue(!isset($result['invalid']), 'Login ou código inválido.', 401);
        return $result;
    }
    public function session(mixed $session, int $now): ?array
    {
        if (!is_array($session) || ($session['id'] ?? null)!==1 || !is_int($session['issuedAt'] ?? null) ||
            !is_int($session['lastSeen'] ?? null) || $session['issuedAt']>$now || $session['lastSeen']>$now ||
            $now-$session['issuedAt']>28800 || $now-$session['lastSeen']>1200) { return null; }
        $owner = $this->db->query('SELECT username,session_epoch,active FROM sn_owner WHERE id=1')[0] ?? null;
        if (!$owner || (int)$owner['active']!==1 || (int)$owner['session_epoch']!==($session['epoch'] ?? null)) { return null; }
        return [...$session,'username'=>$owner['username'],'lastSeen'=>$now];
    }
    public function revoke(string $actor, int $now): void
    {
        $this->db->transaction(function () use ($actor,$now): void {
            $this->db->execute('UPDATE sn_owner SET session_epoch=session_epoch+1 WHERE id=1');
            $this->db->audit('sessions_revoked',$actor,1,$now);
        });
    }
}
