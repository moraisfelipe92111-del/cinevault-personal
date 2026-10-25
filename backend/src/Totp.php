<?php
declare(strict_types=1);
namespace Sintonema\Admin;

final class Totp
{
    public static function encode(string $bytes): string
    {
        $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; $bits = ''; $output = '';
        foreach (str_split($bytes) as $byte) { $bits .= str_pad(decbin(ord($byte)), 8, '0', STR_PAD_LEFT); }
        foreach (str_split($bits, 5) as $part) { $output .= $alphabet[bindec(str_pad($part, 5, '0', STR_PAD_RIGHT))]; }
        return $output;
    }
    public static function decode(string $value): string
    {
        requireValue((bool)preg_match('/^[A-Z2-7]{32}$/D', $value), 'Segundo fator indisponível.', 503);
        $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; $bits = ''; $result = '';
        foreach (str_split($value) as $letter) { $bits .= str_pad(decbin(strpos($alphabet, $letter)), 5, '0', STR_PAD_LEFT); }
        foreach (str_split($bits, 8) as $part) { if (strlen($part) === 8) { $result .= chr(bindec($part)); } }
        return $result;
    }
    /** RFC 6238, SHA-1, 30-second counter. Eight-digit mode exists for the published RFC test vectors. */
    public static function at(string $secretBytes, int $step, int $digits = 6): string
    {
        requireValue($step >= 0 && in_array($digits, [6,8], true), 'Código inválido.');
        $hash = hash_hmac('sha1', pack('N2', intdiv($step, 4294967296), $step % 4294967296), $secretBytes, true);
        $offset = ord($hash[19]) & 15;
        $number = unpack('N', substr($hash, $offset, 4))[1] & 0x7fffffff;
        return str_pad((string)($number % (10 ** $digits)), $digits, '0', STR_PAD_LEFT);
    }
    public static function match(string $secret, string $code, int $now, int $lastStep): ?int
    {
        if (!(bool)preg_match('/^[0-9]{6}$/D', $code)) { return null; }
        $bytes = self::decode($secret); $current = intdiv($now, 30);
        foreach ([$current+1,$current,$current-1] as $step) {
            if ($step > $lastStep && $step >= 0 && hash_equals(self::at($bytes, $step), $code)) { return $step; }
        }
        return null;
    }
}
