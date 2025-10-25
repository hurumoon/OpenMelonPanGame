<?php
require_once __DIR__ . '/config.php';

class VlgLogger
{
    private string $level;
    private string $dir;
    private array $levels = ['debug' => 0, 'info' => 1, 'warn' => 2, 'error' => 3];
    private ?string $rid = null;
    private int $retentionDays = 7;

    public function __construct(array $config)
    {
        $this->level = $config['log']['level'] ?? 'info';
        $this->dir = $config['log']['dir'] ?? vlg_var_path('logs');
        $this->retentionDays = (int) ($config['log']['retentionDays'] ?? 7);
        if (!is_dir($this->dir))
            @mkdir($this->dir, 0777, true);
        $this->cleanupOldLogs();
    }

    private function shouldLog(string $lvl): bool
    {
        return ($this->levels[$lvl] ?? 1) >= ($this->levels[$this->level] ?? 1);
    }

    public function setRid(?string $rid): void
    {
        $this->rid = $rid;
    }

    private function write(string $lvl, string $msg, array $ctx = []): void
    {
        if (!$this->shouldLog($lvl))
            return;
        $line = json_encode([
            'ts' => date('c'),
            'lvl' => $lvl,
            'msg' => $msg,
            'rid' => $this->rid,
            'ctx' => $ctx
        ], JSON_UNESCAPED_UNICODE);
        $file = $this->dir . '/' . date('Y-m-d') . '.log';
        $fp = null;
        try {
            $fp = fopen($file, 'ab');
            if (!$fp)
                throw new \RuntimeException('failed to open log file');
            if (!flock($fp, LOCK_EX))
                throw new \RuntimeException('failed to acquire log file lock');
            if (fwrite($fp, $line . PHP_EOL) === false)
                throw new \RuntimeException('failed to write to log file');
        } catch (\Throwable $e) {
            error_log('[VlgLogger] ' . $e->getMessage());
        } finally {
            if ($fp) {
                flock($fp, LOCK_UN);
                fclose($fp);
            }
        }
    }

    private function cleanupOldLogs(): void
    {
        $dh = @opendir($this->dir);
        if (!$dh)
            return;
        $now = time();
        while (($f = readdir($dh)) !== false) {
            if ($f === '.' || $f === '..')
                continue;
            if (!preg_match('/^(\d{4}-\d{2}-\d{2})\.log$/', $f, $m))
                continue;
            $t = strtotime($m[1] . ' 00:00:00');
            if ($t !== false && ($now - $t) >= ($this->retentionDays * 86400)) {
                @unlink($this->dir . '/' . $f);
            }
        }
        closedir($dh);
    }

    public function debug(string $msg, array $ctx = []): void
    {
        $this->write('debug', $msg, $ctx);
    }
    public function info(string $msg, array $ctx = []): void
    {
        $this->write('info', $msg, $ctx);
    }
    public function warn(string $msg, array $ctx = []): void
    {
        $this->write('warn', $msg, $ctx);
    }
    public function error(string $msg, array $ctx = []): void
    {
        $this->write('error', $msg, $ctx);
    }

    public function exception(\Throwable $e, array $ctx = []): void
    {
        $payload = array_merge([
            'exceptionType' => get_class($e),
            'exceptionMessage' => $e->getMessage(),
            'location' => $e->getFile() . ':' . $e->getLine(),
            'exceptionTime' => date('c'),
        ], $ctx);
        if (!array_key_exists('trace', $payload)) {
            $payload['trace'] = $e->getTraceAsString();
        }
        $this->write('error', 'exception', $payload);
    }
}

function vlg_logger(): VlgLogger
{
    static $logger = null;
    if ($logger)
        return $logger;
    $cfg = vlg_config();
    $logger = new VlgLogger($cfg);
    return $logger;
}
