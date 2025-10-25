<?php
// Minimal config loader: environment & logging
// Reads from .env and environment variables with sane defaults.

function vlg_load_dotenv(string $path): array
{
    $vars = [];
    if (!is_file($path))
        return $vars;
    $lines = @file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#'))
            continue;
        $pos = strpos($line, '=');
        if ($pos === false)
            continue;
        $k = trim(substr($line, 0, $pos));
        $v = trim(substr($line, $pos + 1));
        if ($v !== '' && ($v[0] === '"' || $v[0] === '\''))
            $v = trim($v, "'\"");
        $vars[$k] = $v;
    }
    return $vars;
}

function vlg_var_path(string $subPath = ''): string
{
    $base = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'var';
    if ($subPath === '' || $subPath === DIRECTORY_SEPARATOR)
        return $base;
    return $base . DIRECTORY_SEPARATOR . ltrim($subPath, DIRECTORY_SEPARATOR);
}

function vlg_ensure_directory(string $path): void
{
    if (!is_dir($path))
        @mkdir($path, 0777, true);
}

function vlg_move_legacy_path(string $from, string $to): void
{
    if (!file_exists($from))
        return;

    if (is_dir($from)) {
        vlg_move_legacy_dir($from, $to);
        return;
    }

    $destDir = dirname($to);
    if (!is_dir($destDir))
        @mkdir($destDir, 0777, true);
    if (@rename($from, $to))
        return;

    if (file_exists($to)) {
        $contents = @file_get_contents($from);
        if ($contents !== false)
            @file_put_contents($to, $contents, FILE_APPEND);
        @unlink($from);
        return;
    }

    if (@copy($from, $to))
        @unlink($from);
}

function vlg_move_legacy_dir(string $from, string $to): void
{
    if (!is_dir($from))
        return;

    if (@rename($from, $to))
        return;

    vlg_ensure_directory($to);
    $entries = @scandir($from) ?: [];
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..')
            continue;
        $src = $from . DIRECTORY_SEPARATOR . $entry;
        $dst = $to . DIRECTORY_SEPARATOR . $entry;
        if (is_dir($src)) {
            vlg_move_legacy_dir($src, $dst);
        } else {
            $dstDir = dirname($dst);
            if (!is_dir($dstDir))
                @mkdir($dstDir, 0777, true);
            if (!@rename($src, $dst)) {
                if (@copy($src, $dst))
                    @unlink($src);
            }
        }
    }
    $remaining = @scandir($from);
    if (is_array($remaining) && count(array_diff($remaining, ['.', '..'])) === 0)
        @rmdir($from);
}

function vlg_migrate_legacy_storage(): void
{
    static $migrated = false;
    if ($migrated)
        return;
    $migrated = true;

    $legacyVar = __DIR__ . DIRECTORY_SEPARATOR . 'var';
    if (!is_dir($legacyVar))
        return;

    $storeDir = vlg_var_path('store');
    $logDir = vlg_var_path('logs');
    vlg_ensure_directory($storeDir);
    vlg_ensure_directory($logDir);

    $mappings = [
        $legacyVar . DIRECTORY_SEPARATOR . 'rooms.json' => $storeDir . DIRECTORY_SEPARATOR . 'rooms.json',
        $legacyVar . DIRECTORY_SEPARATOR . 'events' => $storeDir . DIRECTORY_SEPARATOR . 'events',
        $legacyVar . DIRECTORY_SEPARATOR . 'rooms_state' => $storeDir . DIRECTORY_SEPARATOR . 'rooms_state',
        $legacyVar . DIRECTORY_SEPARATOR . 'logs' => $logDir,
    ];

    foreach ($mappings as $from => $to) {
        vlg_move_legacy_path($from, $to);
    }

    $remaining = @scandir($legacyVar);
    if (is_array($remaining) && count(array_diff($remaining, ['.', '..'])) === 0)
        @rmdir($legacyVar);
}

function vlg_config(): array
{
    vlg_migrate_legacy_storage();
    $dotenv = vlg_load_dotenv(__DIR__ . DIRECTORY_SEPARATOR . '.env');
    $env = $dotenv['VLG_ENV'] ?? (getenv('VLG_ENV') ?: 'production'); // 'development'|'production'
    $logLevel = $dotenv['VLG_LOG_LEVEL'] ?? (getenv('VLG_LOG_LEVEL') ?: ($env === 'development' ? 'debug' : 'info'));
    $logDir = vlg_var_path('logs');
    vlg_ensure_directory($logDir);
    $retention = (int) ($dotenv['VLG_LOG_RETENTION_DAYS'] ?? (getenv('VLG_LOG_RETENTION_DAYS') ?: 7));
    $allowedOrigin = $dotenv['VLG_ALLOWED_ORIGIN'] ?? (getenv('VLG_ALLOWED_ORIGIN') ?: 'https://pixelpassion.jp');
    return [
        'env' => $env,
        'log' => [
            'level' => strtolower($logLevel), // debug|info|warn|error
            'dir' => $logDir,
            'retentionDays' => $retention,
        ],
        'cors' => [
            'origin' => $allowedOrigin,
        ],
    ];
}