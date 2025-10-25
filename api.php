<?php
// Simple PHP backend using file-based storage and Server-Sent Events for realtime.

require_once __DIR__ . '/config.php';
$cfg = vlg_config();
$origin = $cfg['cors']['origin'] ?? 'https://pixelpassion.jp';
header('Access-Control-Allow-Origin: ' . $origin);
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
// Prevent MIME-type sniffing
header('X-Content-Type-Options: nosniff');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

$action = $_GET['action'] ?? '';
$storeDir = vlg_var_path('store');
$roomsFile = $storeDir . '/rooms.json';
$eventsDir = $storeDir . '/events';
$stateDir = $storeDir . '/rooms_state';
$joinAttemptsFile = $storeDir . '/join_attempts.json';
$ROOM_TTL_HOURS = 12; // 古い部屋の掃除TTL
$MEMBER_TTL_SEC = 60; // 在室者の最終生存確認からのタイムアウト（秒）
$MAX_ROOMS = 5; // 同時に存在できる部屋数の上限
$JOIN_RATE_WINDOW_SEC = 120;
$JOIN_RATE_DELAY_THRESHOLDS = [3 => 0.5, 4 => 1.0];
$JOIN_RATE_BLOCK_THRESHOLD = 5;
$JOIN_RATE_BLOCK_DURATION = 60;
$PAUSE_TTL_SEC = 20.0; // seconds before forced resume

require_once __DIR__ . '/logger.php';
$log = vlg_logger();
$rid = bin2hex(safe_random_bytes(6));
$log->setRid($rid);
vlg_ensure_directory($storeDir);
vlg_ensure_directory($eventsDir);
vlg_ensure_directory($stateDir);
if (!file_exists($roomsFile))
  file_put_contents($roomsFile, json_encode(['rooms' => []]));

$vlgExceptionContext = [];

function vlg_reset_exception_context(): void
{
  global $vlgExceptionContext;
  $vlgExceptionContext = [];
}

function vlg_update_exception_context(array $updates): void
{
  global $vlgExceptionContext;
  if (!is_array($vlgExceptionContext))
    $vlgExceptionContext = [];
  foreach ($updates as $key => $value) {
    if ($value === null)
      continue;
    $vlgExceptionContext[$key] = $value;
  }
}

function vlg_get_exception_context(): array
{
  global $vlgExceptionContext;
  return is_array($vlgExceptionContext) ? $vlgExceptionContext : [];
}

function vlg_enrich_exception_context_from_array(array $source, bool $includeIdentity = true): void
{
  $updates = [];
  if ($includeIdentity) {
    $stringKeys = [
      'playerId' => 'userId',
      'userId' => 'userId',
      'roomId' => 'roomId',
      'character' => 'character',
      'stage' => 'stage',
    ];
    foreach ($stringKeys as $from => $to) {
      if (!isset($source[$from]))
        continue;
      $value = $source[$from];
      if (is_string($value)) {
        $value = trim($value);
        if ($value === '')
          continue;
        $updates[$to] = $value;
      }
    }
  } else {
    if (isset($source['stage']) && is_string($source['stage'])) {
      $stage = trim($source['stage']);
      if ($stage !== '')
        $updates['stage'] = $stage;
    }
  }
  foreach (['x', 'y'] as $coord) {
    if (!array_key_exists($coord, $source))
      continue;
    $value = $source[$coord];
    if (is_int($value) || is_float($value)) {
      $updates[$coord] = (float) $value;
    } elseif (is_string($value) && $value !== '' && is_numeric($value)) {
      $updates[$coord] = (float) $value;
    }
  }
  if (array_key_exists('alive', $source)) {
    $updates['alive'] = (bool) $source['alive'];
  }
  if (!empty($updates))
    vlg_update_exception_context($updates);
  if (isset($source['event']) && is_array($source['event'])) {
    $eventData = $source['event'];
    $eventUpdates = [];
    foreach (['x', 'y'] as $coord) {
      if (!array_key_exists($coord, $eventData))
        continue;
      $value = $eventData[$coord];
      if (is_int($value) || is_float($value)) {
        $eventUpdates[$coord] = (float) $value;
      } elseif (is_string($value) && $value !== '' && is_numeric($value)) {
        $eventUpdates[$coord] = (float) $value;
      }
    }
    if (array_key_exists('alive', $eventData))
      $eventUpdates['alive'] = (bool) $eventData['alive'];
    if (isset($eventData['stage']) && is_string($eventData['stage'])) {
      $stage = trim($eventData['stage']);
      if ($stage !== '')
        $eventUpdates['stage'] = $stage;
    }
    if (!empty($eventUpdates))
      vlg_update_exception_context($eventUpdates);
  }
}

vlg_reset_exception_context();
vlg_update_exception_context(['action' => $action]);
vlg_enrich_exception_context_from_array($_GET);
$headerPlayerId = $_SERVER['HTTP_X_PLAYER_ID'] ?? null;
if (is_string($headerPlayerId) && trim($headerPlayerId) !== '')
  vlg_update_exception_context(['userId' => trim($headerPlayerId)]);

function read_json($file)
{
  global $log;
  $f = fopen($file, 'r');
  if (!$f) {
    $log->warn('read_json:fopenFailed', ['file' => $file]);
    return ['rooms' => []];
  }
  flock($f, LOCK_SH);
  $content = stream_get_contents($f);
  flock($f, LOCK_UN);
  fclose($f);
  return json_decode($content ?: '{"rooms":[]}', true);
}
function write_json($file, $data)
{
  global $log;
  $f = fopen($file, 'c+');
  if (!$f) {
    $log->error('write_json:fopenFailed', ['file' => $file]);
    return;
  }
  if (!flock($f, LOCK_EX)) {
    fclose($f);
    $log->error('write_json:lockFailed', ['file' => $file]);
    return;
  }
  rewind($f);
  ftruncate($f, 0);
  rewind($f);
  fwrite($f, json_encode($data, JSON_UNESCAPED_UNICODE));
  fflush($f);
  flock($f, LOCK_UN);
  fclose($f);
}

function get_resource_stats(): array
{
  $stats = [];
  $stats['memory'] = round(memory_get_usage(true) / 1024, 1) . ' KB';
  $stats['peak'] = round(memory_get_peak_usage(true) / 1024, 1) . ' KB';

  if (function_exists('getrusage')) {
    $r = getrusage();
    $stats['cpu_user'] = round(($r['ru_utime.tv_sec'] ?? 0) + ($r['ru_utime.tv_usec'] ?? 0) / 1e6, 6);
    $stats['cpu_sys'] = round(($r['ru_stime.tv_sec'] ?? 0) + ($r['ru_stime.tv_usec'] ?? 0) / 1e6, 6);
  } else {
    $stats['cpu_user'] = 'not supported';
    $stats['cpu_sys'] = 'not supported';
  }

  return $stats;
}

function persist_room_member_changes($roomsFile, $roomId, $playerId, callable $mutator): bool
{
  global $log;
  $f = fopen($roomsFile, 'c+');
  if (!$f) {
    $log->error('persist_room_member_changes:fopenFailed', ['file' => $roomsFile]);
    return false;
  }

  if (!flock($f, LOCK_EX)) {
    fclose($f);
    $log->error('persist_room_member_changes:lockFailed', ['file' => $roomsFile]);
    return false;
  }

  rewind($f);
  $raw = stream_get_contents($f);
  $data = json_decode($raw ?: '{"rooms":[]}', true);
  if (!is_array($data) || !isset($data['rooms']) || !is_array($data['rooms'])) {
    $data = ['rooms' => []];
  }

  $changed = false;
  foreach ($data['rooms'] as &$room) {
    if (($room['id'] ?? '') !== $roomId)
      continue;
    foreach (($room['members'] ?? []) as &$member) {
      if (($member['id'] ?? '') !== $playerId)
        continue;
      $changed = (bool) $mutator($room, $member);
      break;
    }
    unset($member);
    if ($changed) {
      rewind($f);
      ftruncate($f, 0);
      rewind($f);
      fwrite($f, json_encode($data, JSON_UNESCAPED_UNICODE));
      fflush($f);
    }
    break;
  }
  unset($room);

  flock($f, LOCK_UN);
  fclose($f);
  return $changed;
}
function read_state($stateDir, $roomId)
{
  $file = $stateDir . '/' . $roomId . '.json';
  if (!file_exists($file))
    return null;
  global $log;
  $f = fopen($file, 'r');
  if (!$f) {
    $log->warn('read_state:fopenFailed', ['file' => $file]);
    return null;
  }
  flock($f, LOCK_SH);
  $content = stream_get_contents($f);
  flock($f, LOCK_UN);
  fclose($f);
  $obj = json_decode($content ?: 'null', true);
  return is_array($obj) ? $obj : null;
}
function write_state($stateDir, $roomId, $state)
{
  $file = $stateDir . '/' . $roomId . '.json';

  global $log;
  $f = fopen($file, 'c+');
  if (!$f) {
    $log->error('write_state:fopenFailed', ['file' => $file]);
    return;
  }
  flock($f, LOCK_EX);
  $encoded = json_encode($state, JSON_UNESCAPED_UNICODE);
  if ($encoded === false) {
    $log->error('write_state:encodeFailed', [
      'file' => $file,
      'error' => json_last_error_msg(),
    ]);
    flock($f, LOCK_UN);
    fclose($f);
    return;
  }
  rewind($f);
  ftruncate($f, 0);
  fwrite($f, $encoded);
  fflush($f);
  flock($f, LOCK_UN);
  fclose($f);
}

function default_room_state(): array
{
  $nowMs = (int) round(microtime(true) * 1000);
  return [
    'lastMs' => $nowMs,
    'timeAlive' => 0,
    'spawnTimer' => 0,
    'waveTimer' => 0,
    'neutralWaveTimes' => [240, 600, 720, 870],
    'neutralWaveIndex' => 0,
    'nextNeutralWaveAt' => 240,
    'neutralWaveRetry' => 0,
    'neutralWaveWarned' => false,
    'specialSpawned' => false,
    'nextBossAt' => 360,
    'nextMidBossAt' => 150,
    'nextReaperAt' => 900,
    'bossRetry' => 0,
    'midBossRetry' => 0,
    'enemies' => [],
    'projectiles' => [],
    'hazards' => [],
    'items' => [],
    'itemTimer' => 40,
    'rewardTimes' => [60, 420, 600],
    'rewardIndex' => 0,
    'nextRewardAt' => 60,
    'riskEventTimes' => [300],
    'riskEventIndex' => 0,
    'nextRiskEventAt' => 300,
    'riskAreas' => [],
    'riskAreaCountdownAckIndex' => null,
    'riskEventEffect' => null,
    'lastEmitMs' => 0,
    'players' => [],
    'playersLastRoomsSync' => 0,
  ];
}

function vlg_should_track_alive_counts(array $enemy): bool
{
  $type = (string) ($enemy['type'] ?? '');
  return $type === 'tank' || $type === 'reaper' || !empty($enemy['boss']);
}

function vlg_normalize_alive_counts(array $counts): array
{
  $keys = ['tanks', 'bosses', 'midBosses', 'bigBosses', 'reapers'];
  foreach ($keys as $key) {
    $counts[$key] = max(0, (int) ($counts[$key] ?? 0));
  }
  $counts['hasBoss'] = $counts['bosses'] > 0;
  $counts['hasBigBoss'] = $counts['bigBosses'] > 0;
  return $counts;
}

function vlg_recompute_alive_counts(array &$state): array
{
  $counts = [
    'tanks' => 0,
    'bosses' => 0,
    'midBosses' => 0,
    'bigBosses' => 0,
    'reapers' => 0,
  ];
  foreach ($state['enemies'] ?? [] as $enemy) {
    if (empty($enemy['alive']))
      continue;
    $type = (string) ($enemy['type'] ?? '');
    if ($type === 'tank')
      $counts['tanks']++;
    if ($type === 'reaper')
      $counts['reapers']++;
    if (!empty($enemy['boss'])) {
      $counts['bosses']++;
      $name = (string) ($enemy['name'] ?? '');
      if ($name === '中型個体')
        $counts['midBosses']++;
      if ($name === '大型個体')
        $counts['bigBosses']++;
    }
  }
  $counts = vlg_normalize_alive_counts($counts);
  $state['aliveCounts'] = $counts;
  return $counts;
}

function vlg_adjust_alive_counts(array &$state, array $enemy, int $delta): array
{
  if (!isset($state['aliveCounts']) || !is_array($state['aliveCounts']))
    $state['aliveCounts'] = vlg_recompute_alive_counts($state);

  $current = $state['aliveCounts'];
  if ($delta !== 0) {
    $type = (string) ($enemy['type'] ?? '');
    if ($type === 'tank')
      $current['tanks'] = max(0, (int) ($current['tanks'] ?? 0) + $delta);
    if ($type === 'reaper')
      $current['reapers'] = max(0, (int) ($current['reapers'] ?? 0) + $delta);
    if (!empty($enemy['boss'])) {
      $current['bosses'] = max(0, (int) ($current['bosses'] ?? 0) + $delta);
      $name = (string) ($enemy['name'] ?? '');
      if ($name === '中型個体')
        $current['midBosses'] = max(0, (int) ($current['midBosses'] ?? 0) + $delta);
      if ($name === '大型個体')
        $current['bigBosses'] = max(0, (int) ($current['bigBosses'] ?? 0) + $delta);
    }
  }

  $current = vlg_normalize_alive_counts($current);
  $state['aliveCounts'] = $current;
  return $current;
}

function ensure_state_shape(?array $state): array
{
  $base = default_room_state();
  if (!is_array($state))
    $state = [];
  $state = array_merge($base, $state);
  foreach (['enemies', 'projectiles', 'hazards', 'items', 'players'] as $key) {
    if (!isset($state[$key]) || !is_array($state[$key]))
      $state[$key] = $base[$key];
  }
  if (!isset($state['neutralWaveTimes']) || !is_array($state['neutralWaveTimes']))
    $state['neutralWaveTimes'] = $base['neutralWaveTimes'];
  if (!isset($state['rewardTimes']) || !is_array($state['rewardTimes']))
    $state['rewardTimes'] = $base['rewardTimes'];
  if (!isset($state['riskEventTimes']) || !is_array($state['riskEventTimes']))
    $state['riskEventTimes'] = $base['riskEventTimes'];
  if (!isset($state['riskAreas']) || !is_array($state['riskAreas']))
    $state['riskAreas'] = [];
  if (!isset($state['riskEventIndex']) || !is_numeric($state['riskEventIndex']))
    $state['riskEventIndex'] = $base['riskEventIndex'];
  if (!isset($state['nextRiskEventAt']) || !is_numeric($state['nextRiskEventAt']))
    $state['nextRiskEventAt'] = $base['nextRiskEventAt'];
  if (!array_key_exists('riskAreaCountdownAckIndex', $state) || ($state['riskAreaCountdownAckIndex'] !== null && !is_numeric($state['riskAreaCountdownAckIndex'])))
    $state['riskAreaCountdownAckIndex'] = null;
  if (!isset($state['neutralWaveWarned']) || !is_bool($state['neutralWaveWarned']))
    $state['neutralWaveWarned'] = false;
  if (!array_key_exists('riskEventEffect', $state) || (!is_array($state['riskEventEffect']) && $state['riskEventEffect'] !== null))
    $state['riskEventEffect'] = null;
  if (!isset($state['playersLastRoomsSync']) || !is_numeric($state['playersLastRoomsSync']))
    $state['playersLastRoomsSync'] = 0;
  if (!isset($state['lastMs']) || !is_numeric($state['lastMs']))
    $state['lastMs'] = $base['lastMs'];
  return $state;
}

function room_member_is_active(array $room, string $playerId): bool
{
  if (($room['status'] ?? 'room') !== 'game')
    return false;
  foreach (($room['members'] ?? []) as $member) {
    if (($member['id'] ?? '') !== $playerId)
      continue;
    if (!empty($member['dead']))
      return false;
    if (isset($member['alive']) && !$member['alive'])
      return false;
    return true;
  }
  return false;
}

function update_player_snapshot($stateDir, $roomId, $playerId, array $snapshot, ?callable $mutator = null): array
{
  $file = $stateDir . '/' . $roomId . '.json';
  global $log;
  $result = ['state' => null, 'player' => null, 'prev' => null];
  $f = fopen($file, 'c+');
  if (!$f) {
    $log->error('update_player_snapshot:fopenFailed', ['file' => $file]);
    return $result;
  }
  if (!flock($f, LOCK_EX)) {
    fclose($f);
    $log->warn('update_player_snapshot:lockFailed', ['file' => $file]);
    return $result;
  }
  try {
    rewind($f);
    $content = stream_get_contents($f);
    $state = json_decode($content ?: 'null', true);
    $state = ensure_state_shape($state);
    $prev = isset($state['players'][$playerId]) && is_array($state['players'][$playerId]) ? $state['players'][$playerId] : null;
    $entry = $prev ?? [];
    $entryChanged = false;
    if (!isset($entry['id']) || $entry['id'] !== $playerId) {
      $entry['id'] = $playerId;
      $entryChanged = true;
    }
    foreach ($snapshot as $key => $value) {
      $shouldUpdate = false;
      if (!array_key_exists($key, $entry)) {
        $shouldUpdate = true;
      } else {
        $current = $entry[$key];
        if (is_numeric($current) && is_numeric($value)) {
          if (abs((float) $current - (float) $value) > 1e-6)
            $shouldUpdate = true;
        } elseif ($current !== $value) {
          $shouldUpdate = true;
        }
      }
      if ($shouldUpdate) {
        $entry[$key] = $value;
        $entryChanged = true;
      }
    }
    if ($prev === null && !$entryChanged)
      $entryChanged = true; // ensure first snapshot persists
    $state['players'][$playerId] = $entry;
    $stateChanged = $entryChanged;
    if ($mutator !== null) {
      $beforePlayer = $state['players'][$playerId];
      $playerEntry =& $state['players'][$playerId];
      try {
        $mutatorResult = $mutator($state, $playerEntry, $prev);
        if (is_bool($mutatorResult)) {
          if ($mutatorResult)
            $stateChanged = true;
        } elseif ($beforePlayer !== $state['players'][$playerId]) {
          $stateChanged = true;
        }
      } catch (Throwable $e) {
        $log->warn('update_player_snapshot:mutatorFailed', [
          'roomId' => $roomId,
          'playerId' => $playerId,
          'error' => $e->getMessage(),
        ]);
      } finally {
        unset($playerEntry);
      }
    }
    if ($stateChanged) {
      $encoded = json_encode($state, JSON_UNESCAPED_UNICODE);
      if ($encoded === false) {
        $log->error('update_player_snapshot:encodeFailed', [
          'roomId' => $roomId,
          'playerId' => $playerId,
          'error' => json_last_error_msg(),
        ]);
      } else {
        rewind($f);
        ftruncate($f, 0);
        fwrite($f, $encoded);
        fflush($f);
      }
    }
    $result = [
      'state' => $state,
      'player' => $state['players'][$playerId] ?? null,
      'prev' => $prev,
    ];
  } finally {
    flock($f, LOCK_UN);
    fclose($f);
  }
  return $result;
}

function fnv1a32(string $str): int
{
  $hash = 0x811c9dc5;
  $prime = 0x01000193;
  $len = strlen($str);
  for ($i = 0; $i < $len; $i++) {
    $hash ^= ord($str[$i]);
    $hash = ($hash * $prime) & 0xffffffff;
  }
  return $hash;
}

function tank_speed_multiplier(string $enemyId): float
{
  $hash = fnv1a32('tankSpeed:' . $enemyId);
  $rand = $hash / 4294967295.0; // 0xffffffff
  return 0.7 + $rand * 0.2;
}

const VLG_TANK_LIMIT = 10;

function append_event($eventsDir, $roomId, $payload)
{
  $file = $eventsDir . '/' . $roomId . '.log';
  global $log;
  $f = fopen($file, 'ab');
  if (!$f) {
    $log->error('append_event:fopenFailed', ['file' => $file]);
    return;
  }
  flock($f, LOCK_EX);
  $entry = [
    'id' => hrtime(true),
    'data' => $payload,
  ];
  fwrite($f, json_encode($entry, JSON_UNESCAPED_UNICODE) . "\n");
  fflush($f);
  flock($f, LOCK_UN);
  fclose($f);
}

function clear_event_log($eventsDir, $roomId)
{
  $file = $eventsDir . '/' . $roomId . '.log';
  if (file_exists($file) && !unlink($file)) {
    global $log;
    $log->warn('clear_event_log:unlinkFailed', ['file' => $file]);
  }
}

function ensure_room_security(array &$room): bool
{
  if (!isset($room['members']) || !is_array($room['members']))
    return false;
  $changed = false;
  foreach ($room['members'] as &$member) {
    if (!isset($member['id']))
      continue;
    if (empty($member['publicId']) || !is_string($member['publicId'])) {
      $member['publicId'] = strtoupper(uid(10));
      $changed = true;
    }
    if (empty($member['authToken']) || !is_string($member['authToken']) || strlen($member['authToken']) < 32) {
      $member['authToken'] = bin2hex(safe_random_bytes(32));
      $changed = true;
    }
  }
  unset($member);
  return $changed;
}

function get_member_public_id(array $room, string $playerId): ?string
{
  foreach ($room['members'] ?? [] as $member) {
    if (($member['id'] ?? '') === $playerId)
      return $member['publicId'] ?? null;
  }
  return null;
}

function get_member_private_id(array $room, string $publicId): ?string
{
  foreach ($room['members'] ?? [] as $member) {
    if (($member['publicId'] ?? '') === $publicId)
      return $member['id'] ?? null;
  }
  return null;
}

function map_pause_ids_to_public(array $room, array $pauseBy): array
{
  $mapped = [];
  foreach ($pauseBy as $pid) {
    if ($pid === 'boss' || $pid === 'server') {
      $mapped[] = $pid;
      continue;
    }
    $pub = get_member_public_id($room, (string) $pid);
    if ($pub !== null)
      $mapped[] = $pub;
  }
  return $mapped;
}

function normalize_pause_time_entry($entry): ?array
{
  $ts = null;
  $publicId = null;
  if (is_array($entry)) {
    if (isset($entry['ts']) && is_numeric($entry['ts']))
      $ts = (float) $entry['ts'];
    elseif (isset($entry['timestamp']) && is_numeric($entry['timestamp']))
      $ts = (float) $entry['timestamp'];
    elseif (isset($entry['time']) && is_numeric($entry['time']))
      $ts = (float) $entry['time'];
    if (isset($entry['publicId']) && is_string($entry['publicId']) && $entry['publicId'] !== '')
      $publicId = (string) $entry['publicId'];
    elseif (isset($entry['playerId']) && is_string($entry['playerId']) && $entry['playerId'] !== '')
      $publicId = (string) $entry['playerId'];
  } elseif (is_numeric($entry)) {
    $ts = (float) $entry;
  }
  if ($ts === null)
    return null;
  $result = ['ts' => $ts];
  if ($publicId !== null)
    $result['publicId'] = $publicId;
  return $result;
}

function normalize_pause_times($pauseTimes): array
{
  $normalized = [];
  if (!is_array($pauseTimes))
    return $normalized;
  foreach ($pauseTimes as $pid => $entry) {
    $norm = normalize_pause_time_entry($entry);
    if ($norm === null)
      continue;
    $normalized[(string) $pid] = $norm;
  }
  return $normalized;
}

function encode_pause_times(array $pauseTimes): array
{
  $encoded = [];
  foreach ($pauseTimes as $pid => $entry) {
    $pidStr = (string) $pid;
    $norm = normalize_pause_time_entry($entry);
    if ($norm === null)
      continue;
    $ts = $norm['ts'] ?? 0.0;
    $publicId = isset($norm['publicId']) && is_string($norm['publicId']) ? (string) $norm['publicId'] : null;
    if ($publicId !== null) {
      $encoded[$pidStr] = ['ts' => $ts, 'publicId' => $publicId];
    } else {
      $encoded[$pidStr] = $ts;
    }
  }
  return $encoded;
}

function normalize_pause_token($value): ?int
{
  if (is_int($value))
    return $value >= 0 ? $value : null;
  if (is_float($value)) {
    if (!is_finite($value))
      return null;
    $intVal = (int) round($value);
    return $intVal >= 0 ? $intVal : null;
  }
  if (is_string($value)) {
    $trimmed = trim($value);
    if ($trimmed === '' || !preg_match('/^\d+$/', $trimmed))
      return null;
    $intVal = (int) $trimmed;
    return $intVal >= 0 ? $intVal : null;
  }
  return null;
}

function normalize_pause_token_map($raw): array
{
  $out = [];
  if (!is_array($raw))
    return $out;
  foreach ($raw as $pid => $value) {
    $token = normalize_pause_token($value);
    if ($token === null)
      continue;
    $out[(string) $pid] = $token;
  }
  return $out;
}

function cleanup_room_pause_flags(array &$room, string $roomId, string $eventsDir, float $ttlSec): bool
{
  $changed = false;
  $now = microtime(true);
  $pauseBy = [];
  if (isset($room['pauseBy']) && is_array($room['pauseBy'])) {
    foreach ($room['pauseBy'] as $pid) {
      if ($pid === null)
        continue;
      $pauseBy[] = (string) $pid;
    }
  }
  $pauseTimes = normalize_pause_times($room['pauseTimes'] ?? []);
  $pauseTokens = normalize_pause_token_map($room['pauseTokens'] ?? []);
  if (empty($pauseBy)) {
    if (isset($room['pauseTimes'])) {
      unset($room['pauseTimes']);
      $changed = true;
    }
    if (isset($room['pauseBy'])) {
      $room['pauseBy'] = [];
    }
    return $changed;
  }
  $keep = [];
  $nextTimes = [];
  foreach ($pauseBy as $pid) {
    if ($pid === 'boss' || $pid === 'server') {
      $keep[] = $pid;
      if (isset($pauseTimes[$pid]))
        $nextTimes[$pid] = $pauseTimes[$pid];
      continue;
    }
    $publicId = get_member_public_id($room, $pid);
    $knownPublicId = isset($pauseTimes[$pid]['publicId']) ? $pauseTimes[$pid]['publicId'] : null;
    if ($publicId === null && $knownPublicId !== null)
      $publicId = $knownPublicId;
    if ($publicId === null) {
      // Player already left the room; drop the stale pause and notify clients.
      $changed = true;
      $resumeId = $knownPublicId ?? $pid;
      unset($pauseTimes[$pid]);
      if (isset($pauseTokens[$pid]))
        $tokenOut = $pauseTokens[$pid];
      else
        $tokenOut = null;
      if ($roomId !== '') {
        $payload = ['type' => 'resume', 'playerId' => $resumeId, 'privateId' => $pid];
        if ($tokenOut !== null)
          $payload['token'] = $tokenOut;
        append_event($eventsDir, $roomId, $payload);
      }
      continue;
    }
    $pausedAt = isset($pauseTimes[$pid]['ts']) ? $pauseTimes[$pid]['ts'] : 0.0;
    if ($pausedAt <= 0) {
      $pausedAt = $now;
      $changed = true;
    }
    if ($now - $pausedAt >= $ttlSec) {
      $changed = true;
      unset($pauseTimes[$pid]);
      $tokenOut = $pauseTokens[$pid] ?? null;
      if ($roomId !== '') {
        $payload = ['type' => 'resume', 'playerId' => $publicId, 'privateId' => $pid];
        if ($tokenOut !== null)
          $payload['token'] = $tokenOut;
        append_event($eventsDir, $roomId, $payload);
      }
      continue;
    }
    $keep[] = $pid;
    $nextTimes[$pid] = ['ts' => $pausedAt, 'publicId' => $publicId];
  }
  if ($keep !== $pauseBy) {
    $room['pauseBy'] = $keep;
    $changed = true;
  }
  if (!empty($nextTimes)) {
    $encoded = encode_pause_times($nextTimes);
    if (!isset($room['pauseTimes']) || $room['pauseTimes'] !== $encoded) {
      $room['pauseTimes'] = $encoded;
      $changed = true;
    }
  } elseif (isset($room['pauseTimes'])) {
    unset($room['pauseTimes']);
    $changed = true;
  }
  if (!empty($pauseTokens)) {
    if (!isset($room['pauseTokens']) || $room['pauseTokens'] !== $pauseTokens) {
      $room['pauseTokens'] = $pauseTokens;
      $changed = true;
    }
  } elseif (isset($room['pauseTokens'])) {
    unset($room['pauseTokens']);
    $changed = true;
  }
  return $changed;
}

function room_public_payload(array $room)
{
  $roomCopy = $room;
  $roomCopy['hasPassword'] = isset($roomCopy['password']);
  unset($roomCopy['password']);
  if (!isset($roomCopy['flags']) || !is_array($roomCopy['flags']))
    $roomCopy['flags'] = [];
  $members = [];
  $ownerPublicId = null;
  foreach (($room['members'] ?? []) as $member) {
    $memberOut = $member;
    $publicId = $member['publicId'] ?? null;
    if ($publicId === null && isset($member['id'])) {
      $publicId = substr(hash('sha256', (string) $member['id']), 0, 12);
    }
    $memberOut['publicId'] = $publicId;
    unset($memberOut['id'], $memberOut['authToken'], $memberOut['lastSeen']);
    $members[] = $memberOut;
    if (($room['owner'] ?? '') === ($member['id'] ?? null) && $ownerPublicId === null)
      $ownerPublicId = $publicId;
  }
  $roomCopy['members'] = $members;
  if ($ownerPublicId !== null) {
    $roomCopy['ownerPublicId'] = $ownerPublicId;
    $roomCopy['owner'] = $ownerPublicId;
  } else {
    unset($roomCopy['owner']);
  }
  if (isset($roomCopy['pauseBy']) && is_array($roomCopy['pauseBy'])) {
    $roomCopy['pauseBy'] = map_pause_ids_to_public($room, $roomCopy['pauseBy']);
  }
  if (isset($roomCopy['pauseTimes'])) {
    unset($roomCopy['pauseTimes']);
  }
  if (isset($roomCopy['pauseTokens'])) {
    unset($roomCopy['pauseTokens']);
  }
  return $roomCopy;
}
function ensure_room_flags(array &$room)
{
  if (!isset($room['flags']) || !is_array($room['flags']))
    $room['flags'] = [];
}
function pause_room_for_boss($roomsFile, &$data, $ri, $roomId, $eventsDir)
{
  $pb = $data['rooms'][$ri]['pauseBy'] ?? [];
  if (!in_array('boss', $pb, true)) {
    $pb[] = 'boss';
    $data['rooms'][$ri]['pauseBy'] = $pb;
    if (!isset($data['rooms'][$ri]['pauseTimes']) || !is_array($data['rooms'][$ri]['pauseTimes'])) {
      $data['rooms'][$ri]['pauseTimes'] = [];
    }
    $data['rooms'][$ri]['pauseTimes']['boss'] = microtime(true);
    write_json($roomsFile, $data);
    append_event($eventsDir, $roomId, ['type' => 'pause', 'playerId' => 'boss', 'privateId' => 'boss']);
  }
}
function resume_room_after_boss($roomsFile, &$data, $ri, $roomId, $eventsDir)
{
  $pb = $data['rooms'][$ri]['pauseBy'] ?? [];
  $pb = array_values(array_filter($pb, function ($p) { return $p !== 'boss'; }));
  $data['rooms'][$ri]['pauseBy'] = $pb;
  if (isset($data['rooms'][$ri]['pauseTimes']) && is_array($data['rooms'][$ri]['pauseTimes'])) {
    unset($data['rooms'][$ri]['pauseTimes']['boss']);
    if (empty($data['rooms'][$ri]['pauseTimes'])) {
      unset($data['rooms'][$ri]['pauseTimes']);
    }
  }
  write_json($roomsFile, $data);
  append_event($eventsDir, $roomId, ['type' => 'resume', 'playerId' => 'boss', 'privateId' => 'boss']);
}
function star_max_radius(array $stage, float $angle)
{
  $outer = $stage['radius'] ?? 600.0;
  $inner = $stage['innerRadius'] ?? ($outer * 0.5);
  $a = fmod($angle, M_PI * 2);
  if ($a < 0)
    $a += M_PI * 2;
  $step = M_PI / 5;
  $seg = floor($a / $step);
  $frac = ($a - $seg * $step) / $step;
  $r1 = ($seg % 2 === 0) ? $outer : $inner;
  $r2 = ($seg % 2 === 0) ? $inner : $outer;
  return $r1 + ($r2 - $r1) * $frac;
}

function clamp_to_star(array $stage, float $x, float $y, float $r = 0.0)
{
  $ang = atan2($y, $x);
  $maxR = star_max_radius($stage, $ang) - $r;
  $dist = hypot($x, $y);
  if ($dist > $maxR) {
    $x = cos($ang) * $maxR;
    $y = sin($ang) * $maxR;
  }
  return [$x, $y];
}

function build_stage_config(string $stageName): array
{
  $stage = [
    'name' => $stageName,
    'type' => 'plaza',
    'halfHeight' => null,
    'chunk' => 320,
  ];
  if ($stageName === 'メロンパン牧場') {
    $stage['type'] = 'ranch';
    $stage['halfHeight'] = 140;
  } elseif ($stageName === 'メロンパン迷宮') {
    $stage['type'] = 'maze';
    $stage['chunk'] = 320;
    $stage['ignoreMobWalls'] = true;
  } elseif ($stageName === 'メロンパン工業地帯') {
    $stage['type'] = 'maze';
    $stage['chunk'] = 320;
    $stage['spikes'] = true;
    $stage['spikeDamage'] = 10;
    $stage['mobHpMul'] = 2.0;
    $stage['midBossHpMul'] = 3.0;
    $stage['bossHpMul'] = 5.0;
    $stage['ignoreMobWalls'] = true;
  } elseif ($stageName === 'メロンパン火山地帯') {
    $stage['type'] = 'volcano';
    $stage['lavaSpeed'] = 25;
    $stage['lavaDamage'] = 999;
    $stage['mobHpMul'] = 6.0;
    $stage['midBossHpMul'] = 4.0;
    $stage['bossHpMul'] = 5.0;
  } elseif ($stageName === 'メロンパン氷山') {
    $stage['slippery'] = true;
    $stage['slipperyFrac'] = 0.3;
    $stage['slipperyFriction'] = 0.9;
    $stage['mobHpMul'] = 3.0;
    $stage['midBossHpMul'] = 5.0;
    $stage['bossHpMul'] = 12.0;
    $stage['healValueMul'] = 0.5;
  } elseif ($stageName === 'メロンパンスキー場') {
    $stage['circular'] = true;
    $stage['slippery'] = true;
    $stage['iceBlocks'] = true;
    $stage['radius'] = 600;
    $stage['slipperyFrac'] = 0.3;
    $stage['slipperyFriction'] = 0.9;
  } elseif ($stageName === 'メロンパン毒沼') {
    $stage['poison'] = true;
    $stage['poisonFrac'] = 0.2;
    $stage['poisonShape'] = 'puddles';
    $stage['poisonPuddleGrid'] = 1400;
    $stage['poisonPuddleChance'] = 0.9;
    $stage['poisonPuddleCountMax'] = 3;
    $stage['poisonPuddleRadiusMin'] = 220;
    $stage['poisonPuddleRadiusMax'] = 940;
    $stage['poisonPuddleRadiusBias'] = 0.52;
    $stage['poisonPuddleAspectMin'] = 0.45;
    $stage['poisonPuddleAspectMax'] = 1.75;
    $stage['poisonPuddleBlend'] = 0.4;
    $stage['poisonPuddleFalloff'] = 1.35;
    $stage['poisonPuddleRadiusJitter'] = 0.26;
    $stage['poisonPuddleThreshold'] = 0.08;
    $stage['poisonPuddleNoise'] = 0.24;
    $stage['poisonPuddleDetailNoise'] = 0.2;
    $stage['poisonPuddleRippleNoise'] = 0.08;
    $stage['mobHpMul'] = 12.0;
    $stage['midBossHpMul'] = 15.0;
    $stage['bossHpMul'] = 16.0;
  }
  return $stage;
}

function pick_stage_element(string $stageName): string
{
  static $elementTypes = ['fire', 'ice', 'lightning', 'dark'];
  static $stageWeights = [
    'メロンパン火山地帯' => ['fire' => 1.3, 'ice' => 1.0, 'lightning' => 1.0, 'dark' => 1.0],
  ];

  $weights = $stageWeights[$stageName] ?? null;
  if ($weights === null) {
    return $elementTypes[array_rand($elementTypes)];
  }

  $total = 0.0;
  foreach ($elementTypes as $elem) {
    $total += $weights[$elem] ?? 1.0;
  }
  if ($total <= 0.0) {
    return $elementTypes[array_rand($elementTypes)];
  }

  $max = mt_getrandmax();
  if ($max <= 0) {
    $max = 1;
  }
  $roll = (mt_rand() / $max) * $total;
  foreach ($elementTypes as $elem) {
    $roll -= $weights[$elem] ?? 1.0;
    if ($roll < 0) {
      return $elem;
    }
  }

  return $elementTypes[count($elementTypes) - 1];
}

function room_has_ignition(array $room): bool
{
  $flags = $room['flags'] ?? null;
  if (is_array($flags)) {
    if (!empty($flags['ignitionMode']) || !empty($flags['ignition']))
      return true;
    if (in_array('ignitionMode', $flags, true) || in_array('ignition', $flags, true))
      return true;
  } elseif (is_string($flags)) {
    if (stripos($flags, 'ignition') !== false)
      return true;
  }
  $candidates = [
    $room['ignitionMode'] ?? null,
    $room['ignition'] ?? null,
    $room['mode'] ?? null,
    $room['options']['ignitionMode'] ?? null,
    $room['options']['ignition'] ?? null,
    $room['settings']['ignitionMode'] ?? null,
    $room['settings']['ignition'] ?? null,
  ];
  foreach ($candidates as $value) {
    if ($value === true)
      return true;
    if (is_string($value) && stripos($value, 'ignition') !== false)
      return true;
  }
  $arrayCandidates = [
    $room['mods'] ?? null,
    $room['modifiers'] ?? null,
    $room['modes'] ?? null,
    $room['options']['mods'] ?? null,
  ];
  foreach ($arrayCandidates as $collection) {
    if (!is_array($collection))
      continue;
    foreach ($collection as $item) {
      if ($item === true)
        return true;
      if (is_string($item) && stripos($item, 'ignition') !== false)
        return true;
    }
  }
  return false;
}
function simulate_enemies($roomsFile, $stateDir, $eventsDir, $roomId)
{
  global $log;
  global $PAUSE_TTL_SEC;
  // single-writer lock per room
  $lockFile = $stateDir . '/sim_' . $roomId . '.lock';
  $lf = fopen($lockFile, 'c+');
  if (!$lf) {
    $log->warn('simulate_enemies:lockOpenFailed', ['file' => $lockFile]);
    return; // cannot simulate
  }
  // non-blocking lock; if not acquired, another process is simulating
  if (!flock($lf, LOCK_EX | LOCK_NB)) {
    fclose($lf);
    return;
  }
  try {
    $data = read_json($roomsFile);
    $room = null;
    $ri = null;
    foreach ($data['rooms'] as $idx => &$r) {
      if (($r['id'] ?? '') === $roomId) {
        $room = &$r;
        $ri = $idx;
        break;
      }
    }
    unset($r);
    if (!$room) {
      flock($lf, LOCK_UN);
      fclose($lf);
      return;
    }
    ensure_room_flags($room);
    if (($room['status'] ?? 'room') !== 'game') {
      flock($lf, LOCK_UN);
      fclose($lf);
      return;
    }
    if (empty($room['simEnemies'])) {
      flock($lf, LOCK_UN);
      fclose($lf);
      return;
    }
    $pauseChanged = cleanup_room_pause_flags($room, $roomId, $eventsDir, $PAUSE_TTL_SEC);
    if ($pauseChanged) {
      $data['rooms'][$ri] = $room;
      write_json($roomsFile, $data);
    }
    if (!empty($room['pauseBy']) && count(array_diff($room['pauseBy'], ['boss'])) > 0) {
      // Keep lastMs current while paused so simulation doesn't jump on resume
      $state = read_state($stateDir, $roomId) ?? [];
      $state['lastMs'] = (int) round(microtime(true) * 1000);
      write_state($stateDir, $roomId, $state);
      flock($lf, LOCK_UN);
      fclose($lf);
      return;
    }
    // Stage/difficulty config (server-side authority)
    $stageName = (string) ($room['stage'] ?? 'メロンパン広場');
    $stage = build_stage_config($stageName);

    $diffName = (string) ($room['difficulty'] ?? 'ふつう');
    $diffHpMul = 1.0;
    $diffSpawnMul = 1.0;
    $diffBulletMul = 0.8; // normal default reduces bullets slightly
    $diffBulletDmgMul = 0.75;
    // 難易度ごとのタンク・中型・大型敵HP倍率は frontend (public/js/constants.js) と同期させる
    $diffTankHpMul = 9.0;
    $diffMidBossHpMul = 5.0;
    $diffBossHpMul = 10.5;
    if ($diffName === 'かんたん') { $diffHpMul = 0.8; $diffSpawnMul = 0.8; $diffBulletMul = 0.6; $diffBulletDmgMul = 0.5; $diffTankHpMul = 4.5; $diffMidBossHpMul = 3.0; $diffBossHpMul = 4.5; }
    elseif ($diffName === 'むずかしい') { $diffHpMul = 1.3; $diffSpawnMul = 1.2; $diffBulletMul = 1.0; $diffBulletDmgMul = 1.0; $diffTankHpMul = 20.0; $diffMidBossHpMul = 14.0; $diffBossHpMul = 37.5; }
    $ignitionEnabled = room_has_ignition($room);
    if ($diffName === 'むずかしい' && $ignitionEnabled) {
      $diffHpMul = 1.5;
      $diffSpawnMul = 2.0;
      $diffBulletMul = 1.5;
      $diffBulletDmgMul = 2.0;
    }

    $RISK_AREA_RADIUS = 90.0;
    $RISK_EVENT_DURATION = 60.0;

    // Helpers: obstacles/LoS for maze and ranch clamp
    $chunkSize = (int) ($stage['chunk'] ?? 320);
    $obsCache = [];
    $keyOf = function ($cx, $cy) {
      return $cx . ',' . $cy;
    };
    $int32 = static function (int $v): int {
      $v &= 0xffffffff;
      return $v >= 0x80000000 ? $v - 0x100000000 : $v;
    };
    $uint32 = static function (int $v) use ($int32): int {
      return $int32($v) & 0xffffffff;
    };
    $seeded = function (int $cx, int $cy, int $n = 1) use ($int32, $uint32) {
      // integer hash -> [0,1]
      $h = $int32($cx * 73856093);
      $h = $int32($h ^ $int32($cy * 19349663));
      $h = $int32($h ^ $int32($n * 83492791));
      $h = $int32($h ^ $int32($h << 13));
      $h = $int32($h ^ $int32($h >> 17));
      $h = $int32($h ^ $int32($h << 5));
      // normalize to [0,1]
      $u = $uint32($h);
      return $u / 0xffffffff;
    };
    $genChunk = function (int $cx, int $cy) use (&$obsCache, $keyOf, $seeded, $stage, $chunkSize) {
      $k = $keyOf($cx, $cy);
      if (isset($obsCache[$k]))
        return $obsCache[$k];
      $rects = [];
      if (($stage['type'] ?? 'plaza') === 'maze') {
        $baseX = $cx * $chunkSize;
        $baseY = $cy * $chunkSize;
        $count = 1 + (int) floor($seeded($cx, $cy) * 3);
        for ($i = 0; $i < $count; $i++) {
          $rx = (int) ($baseX + 20 + $seeded($cx, $cy, $i + 1) * ($chunkSize - 60));
          $ry = (int) ($baseY + 20 + $seeded($cx + 11, $cy - 7, $i + 2) * ($chunkSize - 60));
          $rw = (int) (60 + $seeded($cx - 3, $cy + 5, $i + 3) * 160);
          $rh = (int) (40 + $seeded($cx + 9, $cy + 13, $i + 4) * 140);
          $rects[] = ['x' => $rx, 'y' => $ry, 'w' => $rw, 'h' => $rh];
        }
      }
      $obsCache[$k] = $rects;
      return $rects;
    };
    $getNearbyObstacles = function (float $px, float $py) use ($chunkSize, $genChunk) {
      $cx = (int) floor($px / $chunkSize);
      $cy = (int) floor($py / $chunkSize);
      $res = [];
      for ($dy = -1; $dy <= 1; $dy++) {
        for ($dx = -1; $dx <= 1; $dx++) {
          $res = array_merge($res, $genChunk($cx + $dx, $cy + $dy));
        }
      }
      return $res;
    };
    $circleRectCollide = function (float $cx, float $cy, float $cr, array $r) {
      $nx = max($r['x'], min($cx, $r['x'] + $r['w']));
      $ny = max($r['y'], min($cy, $r['y'] + $r['h']));
      $dx = $cx - $nx;
      $dy = $cy - $ny;
      return $dx * $dx + $dy * $dy < $cr * $cr;
    };
    $segmentsIntersect = function ($ax, $ay, $bx, $by, $cx, $cy, $dx, $dy) {
      $orient = function ($ax, $ay, $bx, $by, $cx, $cy) {
        $v = ($bx - $ax) * ($cy - $ay) - ($by - $ay) * ($cx - $ax);
        if ($v > 0)
          return 1;
        if ($v < 0)
          return -1;
        return 0;
      };
      $onSeg = function ($ax, $ay, $bx, $by, $px, $py) {
        return (min($ax, $bx) <= $px && $px <= max($ax, $bx) && min($ay, $by) <= $py && $py <= max($ay, $by));
      };
      $o1 = $orient($ax, $ay, $bx, $by, $cx, $cy);
      $o2 = $orient($ax, $ay, $bx, $by, $dx, $dy);
      $o3 = $orient($cx, $cy, $dx, $dy, $ax, $ay);
      $o4 = $orient($cx, $cy, $dx, $dy, $bx, $by);
      if ($o1 * $o2 < 0 && $o3 * $o4 < 0)
        return true;
      if ($o1 === 0 && $onSeg($ax, $ay, $bx, $by, $cx, $cy))
        return true;
      if ($o2 === 0 && $onSeg($ax, $ay, $bx, $by, $dx, $dy))
        return true;
      if ($o3 === 0 && $onSeg($cx, $cy, $dx, $dy, $ax, $ay))
        return true;
      if ($o4 === 0 && $onSeg($cx, $cy, $dx, $dy, $bx, $by))
        return true;
      return false;
    };
    $lineIntersectsRect = function ($x1, $y1, $x2, $y2, $r) use ($segmentsIntersect) {
      // edges: top, right, bottom, left
      $edges = [
        [$r['x'], $r['y'], $r['x'] + $r['w'], $r['y']],
        [$r['x'] + $r['w'], $r['y'], $r['x'] + $r['w'], $r['y'] + $r['h']],
        [$r['x'], $r['y'] + $r['h'], $r['x'] + $r['w'], $r['y'] + $r['h']],
        [$r['x'], $r['y'], $r['x'], $r['y'] + $r['h']],
      ];
      foreach ($edges as $e) {
        if ($segmentsIntersect($x1, $y1, $x2, $y2, $e[0], $e[1], $e[2], $e[3]))
          return true;
      }
      // fully inside rectangle also counts as blocked
      if (
        $x1 >= $r['x'] && $x1 <= $r['x'] + $r['w'] && $y1 >= $r['y'] && $y1 <= $r['y'] + $r['h'] &&
        $x2 >= $r['x'] && $x2 <= $r['x'] + $r['w'] && $y2 >= $r['y'] && $y2 <= $r['y'] + $r['h']
      )
        return true;
      return false;
    };
    $hasWallBetween = function ($ax, $ay, $bx, $by) use ($stage, $getNearbyObstacles, $lineIntersectsRect) {

      if (($stage['type'] ?? 'plaza') !== 'maze' || !empty($stage['ignoreMobWalls']))

        return false;
      $mx = ($ax + $bx) * 0.5;
      $my = ($ay + $by) * 0.5;
      $obs = $getNearbyObstacles($mx, $my);
      foreach ($obs as $r) {
        if ($lineIntersectsRect($ax, $ay, $bx, $by, $r))
          return true;
      }
      return false;
    };
    $clamp = function ($v, $a, $b) {
      return max($a, min($b, $v));
    };
    $distToPlayers = function ($x, $y, $players) {
      $best = 1e18;
      foreach ($players as $p) {
        $d = hypot($p['x'] - $x, $p['y'] - $y);
        if ($d < $best)
          $best = $d;
      }
      return $best;
    };
    $stateFile = $stateDir . '/' . $roomId . '.json';
    $state = read_state($stateDir, $roomId);
    if ($state === null) {
      $state = default_room_state();
      if (file_exists($stateFile)) {
        $log->warn('simulate_enemies:stateLoadFailed', ['roomId' => $roomId, 'file' => $stateFile]);
        if (function_exists('error_clear_last'))
          error_clear_last();
        if (@unlink($stateFile)) {
          $log->info('simulate_enemies:stateFileDeleted', ['roomId' => $roomId, 'file' => $stateFile]);
        } else {
          $err = error_get_last();
          $log->warn('simulate_enemies:stateUnlinkFailed', [
            'roomId' => $roomId,
            'file' => $stateFile,
            'error' => $err['message'] ?? null,
          ]);
        }
        write_state($stateDir, $roomId, $state);
        $log->info('simulate_enemies:stateRestored', ['roomId' => $roomId]);
      }
    }
    $state = ensure_state_shape($state);
    $nowMs = (int) round(microtime(true) * 1000);
    // use the full elapsed time between ticks so timeAlive matches real gameplay time
    $prevAlive = (float) ($state['timeAlive'] ?? 0);
    $dt = max(0, ($nowMs - (int) ($state['lastMs'] ?? $nowMs)) / 1000);
    $state['lastMs'] = $nowMs;
    $state['timeAlive'] = $prevAlive + $dt;
    $tAlive = (float) ($state['timeAlive'] ?? 0);
    // reset boss timers when starting a fresh game
    if ($prevAlive < 1) {
      $state['nextBossAt'] = 360; // seconds
      $state['nextMidBossAt'] = 150; // seconds
      $state['nextReaperAt'] = 900; // seconds
      foreach ($room['members'] as $m) {
        $nm = (string) ($m['name'] ?? '');
        if ($nm === 'ボス' || strtolower($nm) === 'boss') {
          $state['nextBossAt'] = 30;
          break;
        }
      }
    }

    // collect alive players with recent positions
    $players = [];
    $now = microtime(true);
    $statePlayers = [];
    if (isset($state['players']) && is_array($state['players']))
      $statePlayers = $state['players'];
    foreach ($statePlayers as $pid => $snap) {
      if (!is_array($snap))
        continue;
      if (isset($snap['alive']) && !$snap['alive'])
        continue;
      $seen = (float) ($snap['lastSeen'] ?? 0);
      if ($seen <= 0 || ($now - $seen) > 60)
        continue;
      if (!isset($snap['x']) || !isset($snap['y']))
        continue;
      $decoys = [];
      if (isset($snap['decoys']) && is_array($snap['decoys'])) {
        $decoysSeen = isset($snap['decoysSeen']) ? (float) $snap['decoysSeen'] : $seen;
        if ($decoysSeen > 0 && ($now - $decoysSeen) <= 5) {
          $limit = 16;
          foreach ($snap['decoys'] as $entry) {
            if (!is_array($entry))
              continue;
            if (count($decoys) >= $limit)
              break;
            if (!isset($entry['x']) || !isset($entry['y']))
              continue;
            $dx = (float) $entry['x'];
            $dy = (float) $entry['y'];
            if (!is_finite($dx) || !is_finite($dy))
              continue;
            $decoys[] = ['x' => $dx, 'y' => $dy];
          }
        }
      }
      $players[] = ['id' => $pid, 'x' => (float) $snap['x'], 'y' => (float) $snap['y'], 'decoys' => $decoys];
    }
    if (empty($players)) {
      foreach ($room['members'] as $m) {
        if (!empty($m['dead']))
          continue;
        $seen = (float) ($m['lastSeen'] ?? 0);
        if ($now - $seen > 60)
          continue;
        if (!isset($m['x']) || !isset($m['y']))
          continue;
        $players[] = ['id' => $m['id'], 'x' => (float) $m['x'], 'y' => (float) $m['y'], 'decoys' => []];
      }
    }
    $playerCount = count($players);
    if ($playerCount === 0) {
      $state['lastMs'] = (int) round(microtime(true) * 1000);
      // Roll back the timeAlive increment applied before the guard so timers truly pause
      $state['timeAlive'] = $prevAlive;
      write_state($stateDir, $roomId, $state);
      $log->info('simulate_enemies:noPlayers', [
        'roomId' => $roomId,
        'memberCount' => count($room['members'] ?? []),
      ]);
      flock($lf, LOCK_UN);
      fclose($lf);
      return;
    }
// Freeze only if literally no connected members (regardless of short inactivity),
// and do NOT push boss timers back.
$connectedCount = 0;
foreach (($room['members'] ?? []) as $m) {
  if (empty($m['dead'])) $connectedCount++;
}
if ($connectedCount === 0) {
  // keep lastMs current, but don't advance timers or reschedule bosses
  $state['lastMs'] = (int) round(microtime(true) * 1000);
  write_state($stateDir, $roomId, $state);
  flock($lf, LOCK_UN);
  fclose($lf);
  return;
}

    $recomputeAliveCounts = function () use (&$state) {
      return vlg_recompute_alive_counts($state);
    };
    $adjustAliveCounts = function (array $enemy, int $delta) use (&$state, $recomputeAliveCounts, $log, $roomId) {
      if ($delta === 0)
        return;
      if (!isset($state['aliveCounts']) || !is_array($state['aliveCounts']))
        $before = $recomputeAliveCounts();
      else
        $before = vlg_normalize_alive_counts($state['aliveCounts']);
      $current = vlg_adjust_alive_counts($state, $enemy, $delta);
      if ($current !== $before) {
        $log->debug('simulate_enemies:aliveCountsDelta', [
          'roomId' => $roomId,
          'enemyId' => $enemy['id'] ?? null,
          'type' => (string) ($enemy['type'] ?? ''),
          'delta' => $delta,
          'counts' => $current,
        ]);
      }
    };
    $prevAliveCounts = null;
    if (isset($state['aliveCounts']) && is_array($state['aliveCounts']))
      $prevAliveCounts = vlg_normalize_alive_counts($state['aliveCounts']);
    $counts = $recomputeAliveCounts();
    $countsJson = json_encode($counts);
    $prevCountsJson = $prevAliveCounts === null ? null : json_encode($prevAliveCounts);
    if ($prevAliveCounts === null || $prevCountsJson !== $countsJson) {
      $log->debug('simulate_enemies:aliveCountsRecomputed', ['roomId' => $roomId, 'counts' => $counts]);
    }

    $riskEffectState = $state['riskEventEffect'] ?? null;
    $riskEffectType = null;
    if (is_array($riskEffectState)) {
      $effectType = $riskEffectState['type'] ?? null;
      if ($effectType === 'exp' || $effectType === 'melon') {
        $riskEffectType = $effectType;
      } else {
        $riskEffectState = null;
        $state['riskEventEffect'] = null;
      }
    } elseif ($riskEffectState !== null) {
      $riskEffectState = null;
      $state['riskEventEffect'] = null;
    }

    $healInterval = 40 / 1.15; // seconds (約15%出現率アップ)
    $state['itemTimer'] = ($state['itemTimer'] ?? $healInterval) + $dt;
    if ($state['itemTimer'] >= $healInterval) {
      $state['itemTimer'] = 0;
      $maxHeals = 2;
      if ($playerCount > 0 && count($state['items']) < $maxHeals) {
        $cx = 0.0; $cy = 0.0;
        foreach ($players as $p) { $cx += $p['x']; $cy += $p['y']; }
        $cx /= $playerCount; $cy /= $playerCount;
        $ang = (mt_rand() / mt_getrandmax()) * M_PI * 2;
        $r = 200 + (mt_rand() / mt_getrandmax()) * 200;
        $ix = $cx + cos($ang) * $r; $iy = $cy + sin($ang) * $r;
        if (($stage['type'] ?? 'plaza') === 'ranch') {
          $hh = (float) ($stage['halfHeight'] ?? 140);
          $iy = max(-$hh + 12, min($hh - 12, $iy));
        }
        if (($stage['type'] ?? 'plaza') === 'maze') {
          $tries = 6;
          while ($tries-- > 0) {
            $obs = $getNearbyObstacles($ix, $iy);
            $blocked = false;
            foreach ($obs as $rect) { if ($circleRectCollide($ix, $iy, 8.0, $rect)) { $blocked = true; break; } }
            if (!$blocked) break;
            $ang2 = (mt_rand() / mt_getrandmax()) * M_PI * 2;
            $ix = $cx + cos($ang2) * $r; $iy = $cy + sin($ang2) * $r;
          }
        }
        $healVal = (int) round(20 * ($stage['healValueMul'] ?? 1));
        $state['items'][] = ['id' => substr(bin2hex(safe_random_bytes(6)), 0, 8), 'type' => 'heal', 'x' => $ix, 'y' => $iy, 'r' => 8, 'value' => $healVal];
        if ($riskEffectType === 'melon') {
          $extraAng = (mt_rand() / mt_getrandmax()) * M_PI * 2;
          $extraDist = 30.0 + (mt_rand() / mt_getrandmax()) * 30.0;
          $ex = $ix;
          $ey = $iy;
          $extraTries = 4;
          while ($extraTries-- > 0) {
            $ex = $ix + cos($extraAng) * $extraDist;
            $ey = $iy + sin($extraAng) * $extraDist;
            if (!empty($stage['star'])) {
              [$ex, $ey] = clamp_to_star($stage, $ex, $ey, 8.0);
            }
            if (($stage['type'] ?? 'plaza') === 'ranch') {
              $hh = (float) ($stage['halfHeight'] ?? 140);
              $ey = max(-$hh + 12.0, min($hh - 12.0, $ey));
            }
            $blockedExtra = false;
            if (($stage['type'] ?? 'plaza') === 'maze' && empty($stage['ignoreMobWalls'])) {
              $obsExtra = $getNearbyObstacles($ex, $ey);
              foreach ($obsExtra as $rect) {
                if ($circleRectCollide($ex, $ey, 8.0, $rect)) {
                  $blockedExtra = true;
                  break;
                }
              }
            }
            if (($stage['type'] ?? '') === 'volcano') {
              $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 25.0) * $tAlive);
              $ex = max($ex, $lavaX + 9.0);
            }
            if (!$blockedExtra)
              break;
            $extraAng = (mt_rand() / mt_getrandmax()) * M_PI * 2;
          }
          $state['items'][] = ['id' => substr(bin2hex(safe_random_bytes(6)), 0, 8), 'type' => 'heal', 'x' => $ex, 'y' => $ey, 'r' => 8, 'value' => $healVal];
        }
        $extraPlayers = max(0, $playerCount - 2);
        $bookChanceBase = 0.6; // base chance for grimoires
        $bookChanceStep = 0.1; // per-extra-player increment
        $bookChance = min(0.9, ($bookChanceBase + $bookChanceStep * $extraPlayers) * 1.15); // 約15%出現率アップ
        if (mt_rand() / mt_getrandmax() < $bookChance) {
          $ang = (mt_rand() / mt_getrandmax()) * M_PI * 2;
          $r = 240 + (mt_rand() / mt_getrandmax()) * 240;
          $ix = $cx + cos($ang) * $r; $iy = $cy + sin($ang) * $r;
          if (($stage['type'] ?? 'plaza') === 'ranch') {
            $hh = (float) ($stage['halfHeight'] ?? 140);
            $iy = max(-$hh + 12, min($hh - 12, $iy));
          }
          if (($stage['type'] ?? 'plaza') === 'maze') {
            $tries = 6;
            while ($tries-- > 0) {
              $obs = $getNearbyObstacles($ix, $iy);
              $blocked = false;
              foreach ($obs as $rect) { if ($circleRectCollide($ix, $iy, 8.0, $rect)) { $blocked = true; break; } }
              if (!$blocked) break;
              $ang2 = (mt_rand() / mt_getrandmax()) * M_PI * 2;
              $ix = $cx + cos($ang2) * $r; $iy = $cy + sin($ang2) * $r;
            }
          }
          $elems = ['fire', 'ice', 'lightning', 'dark'];
          if ($stageName === 'メロンパンスキー場') $elems[] = 'fire';
          $elem = $elems[array_rand($elems)];
          $state['items'][] = ['id' => substr(bin2hex(safe_random_bytes(6)), 0, 8), 'type' => 'grimoire', 'elem' => $elem, 'x' => $ix, 'y' => $iy, 'r' => 8, 'value' => 0];
        }
      }
    }

    // helper: nearest player to (ex,ey)
    $nearest = function ($ex, $ey, $skipDecoys = false) use ($players) {
      $bestPlayer = $players[0];
      $bestPlayerDist = hypot($players[0]['x'] - $ex, $players[0]['y'] - $ey);
      foreach ($players as $p) {
        $d = hypot($p['x'] - $ex, $p['y'] - $ey);
        if ($d < $bestPlayerDist) {
          $bestPlayerDist = $d;
          $bestPlayer = $p;
        }
      }
      $bestScore = $bestPlayerDist;
      $bestDecoy = null;
      $bestDecoyDist = null;
      $DECOY_PULL_RADIUS = 360.0;
      $DECOY_PULL_RADIUS_SQ = $DECOY_PULL_RADIUS * $DECOY_PULL_RADIUS;
      $DECOY_AGGRO_BIAS = 80.0;
      if (!$skipDecoys) {
        foreach ($players as $p) {
          if (empty($p['decoys']) || !is_array($p['decoys']))
            continue;
          foreach ($p['decoys'] as $decoy) {
            if (!is_array($decoy) || !isset($decoy['x'], $decoy['y']))
              continue;
            $dx = (float) $decoy['x'] - $ex;
            $dy = (float) $decoy['y'] - $ey;
            $distSq = $dx * $dx + $dy * $dy;
            if ($distSq > $DECOY_PULL_RADIUS_SQ)
              continue;
            $dist = sqrt($distSq);
            $effective = max(0.0, $dist - $DECOY_AGGRO_BIAS);
            if ($effective < $bestScore) {
              $bestScore = $effective;
              $bestDecoyDist = $dist;
              $bestDecoy = ['x' => (float) $decoy['x'], 'y' => (float) $decoy['y'], 'decoyOwner' => $p['id'] ?? null];
            }
          }
        }
      }
      if ($bestDecoy !== null)
        return [$bestDecoy, $bestDecoyDist];
      return [$bestPlayer, $bestPlayerDist];
    };

    // spawn control: gentle ramp + unlock new types over time
    $state['spawnTimer'] = ($state['spawnTimer'] ?? 0) - $dt;
    $state['waveTimer'] = ($state['waveTimer'] ?? 0) - $dt;
    $tAlive = ($state['timeAlive'] ?? 0);
    $elemSpawnDefs = [
      'かんたん' => ['start' => 30.0, 'chance' => 0.9],
      'ふつう' => ['start' => 20.0, 'chance' => 0.95],
      'むずかしい' => ['start' => 10.0, 'chance' => 1.0],
    ];
    $elemCfg = $elemSpawnDefs[$diffName] ?? ['start' => 0.0, 'chance' => 0.3];
    $elemChance = ($tAlive >= $elemCfg['start']) ? $elemCfg['chance'] : 0.0;
    $elementTypes = ['fire', 'ice', 'lightning', 'dark'];
    $spawnInterval = max(0.45, 1.2 - $tAlive * 0.0004) / $diffSpawnMul;
    // Increase baseline target and ramp to keep density similar to client
    $targetCount = min(120, (int) round((10 + (int) floor($tAlive / 6)) * $diffSpawnMul));
    $doSpawn = (($state['spawnTimer'] ?? 0) <= 0 && count($state['enemies']) < $targetCount);
    if ($doSpawn) {
      $state['spawnTimer'] = $spawnInterval;
      // spawn around players' centroid
      $cx = 0;
      $cy = 0;
        foreach ($players as $p) {
        $cx += $p['x'];
        $cy += $p['y'];
      }
      $cx /= $playerCount;
      $cy /= $playerCount;
      $angle = (mt_rand() / mt_getrandmax()) * M_PI * 2;
      $radius = 420 + mt_rand(0, 120);
      $ex = $cx + cos($angle) * $radius;
      $ey = $cy + sin($angle) * $radius;
      // decide enemy type based on timeAlive (unlock progressively)
      $roll = (mt_rand() / mt_getrandmax());
      $etype = 'chaser';
      if ($tAlive > 30 && $roll < 0.25)
        $etype = 'zig';
      if ($tAlive > 90 && $roll < 0.30)
        $etype = 'shooter';
      if ($tAlive > 180 && $roll < 0.60)
        $etype = 'dasher';
      if ($tAlive > 270 && $roll < 0.72)
        $etype = 'bomber';
      if ($tAlive > 360 && $roll < 0.80)
        $etype = 'tank';
      if ($etype === 'tank') {
        if ((int) ($state['aliveCounts']['tanks'] ?? 0) >= VLG_TANK_LIMIT) {
          $etype = 'chaser';
        }
      }
      $baseHp = 8 + (int) floor($tAlive / 20);
      $hp = max(1, (int) round($baseHp * (1 + min(1.8, $tAlive * 0.001)) * $diffHpMul * ($stage['mobHpMul'] ?? 1)));
      if ($etype === 'tank')
        $hp = (int) round($hp * $diffTankHpMul);
      // extra durability boost every 2 minutes (10% each)
      $hp = (int) round($hp * (1 + floor($tAlive / 120) * 0.1));
      $spd = (40 + min(120, $tAlive * 0.08));
      $enemyId = substr(bin2hex(safe_random_bytes(6)), 0, 8);
      $tankSpeedMul = null;
      if ($etype === 'tank') {
        $tankSpeedMul = tank_speed_multiplier($enemyId);
        $spd *= 0.6 * $tankSpeedMul;
      }
      $spawnR = ($etype === 'tank') ? 12.0 : 9.0;
      if (($stage['type'] ?? '') === 'volcano') {
  $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 25.0) * $tAlive);
        $ex = max($ex, $lavaX + $spawnR + 1.0);
      }
      $e = [
        'id' => $enemyId,
        'type' => $etype,
        'x' => $ex,
        'y' => $ey,
        'r' => $spawnR,
        'spd' => $spd,
        'hp' => $hp,
        'maxHp' => $hp,
        'alive' => true,
        't' => 0,
        'cd' => 0,
        'phase' => (mt_rand() / mt_getrandmax()) * M_PI * 2,
      ];
      if ($etype === 'tank') {
        $e['tankSpeedMul'] = $tankSpeedMul;
      }
      if ($etype === 'shooter') {
        $e['cd'] = (1.8 + (mt_rand() / mt_getrandmax()) * 1.2) / $diffBulletMul;
        $e['range'] = 260 + (mt_rand() / mt_getrandmax()) * 120;
      }
      if ($etype === 'dasher') {
        $e['state'] = 'stalk';
        $e['cd'] = 1.2;
        $e['dash'] = ['wind' => 0.0, 'vx' => 0.0, 'vy' => 0.0, 'time' => 0.0];
      }
      if ($etype === 'bomber') {
        $e['fuse'] = -1.0;
        $e['blast'] = ['r' => 56, 'fuseTime' => 0.8];
        $e['spd'] *= 0.9;
      }
      if ((mt_rand() / mt_getrandmax()) < $elemChance) {
        $e['elem'] = $elementTypes[array_rand($elementTypes)];
      }
      $state['enemies'][] = $e;
      if (vlg_should_track_alive_counts($e))
        $adjustAliveCounts($e, 1);
    }

    if (empty($state['specialSpawned']) && (($diffName === 'ふつう' && $tAlive >= 600) || ($diffName === 'むずかしい' && $tAlive >= 120))) {
      $cx = 0; $cy = 0;
      foreach ($players as $p) { $cx += $p['x']; $cy += $p['y']; }
      $cx /= $playerCount; $cy /= $playerCount;
      $angle = (mt_rand() / mt_getrandmax()) * M_PI * 2;
      $radius = 360;
      $ex = $cx + cos($angle) * $radius;
      $ey = $cy + sin($angle) * $radius;
      $spawnR = 14.0;
      if (($stage['type'] ?? 'plaza') === 'ranch') {
        $hh = (float) ($stage['halfHeight'] ?? 140);
        $ey = max(-$hh + 24, min($hh - 24, $ey));
      } elseif (($stage['type'] ?? 'plaza') === 'maze') {
        $tries = 12;
        while ($tries-- > 0) {
          $obs = $getNearbyObstacles($ex, $ey);
          $blocked = false;
          foreach ($obs as $rect) {
            if ($circleRectCollide($ex, $ey, 22, $rect)) { $blocked = true; break; }
          }
          if (!$blocked) break;
          $ang2 = (mt_rand() / mt_getrandmax()) * M_PI * 2;
          $ex = $cx + cos($ang2) * $radius;
          $ey = $cy + sin($ang2) * $radius;
        }
      }
      if (($stage['type'] ?? '') === 'volcano') {
  $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 25.0) * $tAlive);
        $ex = max($ex, $lavaX + $spawnR + 1.0);
      }
      $elem = $elementTypes[array_rand($elementTypes)];
      $hpMax = (int) round(2000 * $diffHpMul * ($stage['mobHpMul'] ?? 1));
      $state['enemies'][] = [
        'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
        'type' => 'special',
        'name' => '特殊個体',
        'x' => $ex,
        'y' => $ey,
        'r' => $spawnR,
        'hp' => $hpMax,
        'maxHp' => $hpMax,
        'spd' => 30,
        'alive' => true,
        'dmgTakenMul' => 0.1,
        'elem' => $elem,
      ];
      $state['specialSpawned'] = true;
    }

    // timed reward area spawns
    $rewardTimes = $state['rewardTimes'] ?? [60, 420, 600];
    $ri2 = (int) ($state['rewardIndex'] ?? 0);
    $nextRewardAt = $state['nextRewardAt'] ?? ($rewardTimes[$ri2] ?? PHP_INT_MAX);
    if (empty($stage['circular']) && $ri2 < count($rewardTimes) && $tAlive >= $nextRewardAt) {
      if ($playerCount > 0) {
        $cx = 0.0; $cy = 0.0;
        foreach ($players as $p) { $cx += $p['x']; $cy += $p['y']; }
        $cx /= $playerCount; $cy /= $playerCount;
        $dist = 800 + (mt_rand() / mt_getrandmax()) * 200;
        $ang = (mt_rand() / mt_getrandmax()) * M_PI * 2;
        $ix = $cx + cos($ang) * $dist;
        $iy = $cy + sin($ang) * $dist;
        if (($stage['type'] ?? 'plaza') === 'ranch') {
          $hh = (float) ($stage['halfHeight'] ?? 140);
          $iy = max(-$hh + 40, min($hh - 40, $iy));
        } elseif (($stage['type'] ?? 'plaza') === 'maze') {
          $tries = 12;
          while ($tries-- > 0) {
            $obs = $getNearbyObstacles($ix, $iy);
            $blocked = false;
            foreach ($obs as $rect) { if ($circleRectCollide($ix, $iy, 40, $rect)) { $blocked = true; break; } }
            if (!$blocked) break;
            $ang2 = (mt_rand() / mt_getrandmax()) * M_PI * 2;
            $ix = $cx + cos($ang2) * $dist;
            $iy = $cy + sin($ang2) * $dist;
          }
        }
        if (($stage['type'] ?? '') === 'volcano') {
          $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 25.0) * $tAlive);
          $ix = max($ix, $lavaX + 40 + 1.0);
        }
        append_event($eventsDir, $roomId, ['type' => 'rewardArea', 'x' => $ix, 'y' => $iy, 'r' => 80]);
      }
      $ri2++;
      $state['rewardIndex'] = $ri2;
      $state['nextRewardAt'] = $rewardTimes[$ri2] ?? PHP_INT_MAX;
    }

    // risk reward event spawn (server-side authority)
    $riskEventTimes = $state['riskEventTimes'] ?? [300];
    $riskIdx = (int) ($state['riskEventIndex'] ?? 0);
    $nextRiskAt = $state['nextRiskEventAt'] ?? ($riskEventTimes[$riskIdx] ?? PHP_INT_MAX);
    $riskEffect = $riskEffectState;
    $riskAreas = [];
    $riskAreasChanged = false;
    if (isset($state['riskAreas']) && is_array($state['riskAreas'])) {
      foreach ($state['riskAreas'] as $area) {
        if (!is_array($area)) {
          $riskAreasChanged = true;
          continue;
        }
        $duration = isset($area['duration']) ? (float) $area['duration'] : $RISK_EVENT_DURATION;
        if (!is_finite($duration) || $duration <= 0)
          $duration = $RISK_EVENT_DURATION;
        $expiresAtRaw = isset($area['expiresAt']) ? (float) $area['expiresAt'] : null;
        $countdownAtRaw = isset($area['countdownAt']) ? (float) $area['countdownAt'] : null;
        $countdownAt = is_finite($countdownAtRaw) ? $countdownAtRaw : null;
        if ($countdownAt === null && is_finite($expiresAtRaw))
          $countdownAt = $expiresAtRaw - $duration;
        if ($countdownAt === null || !is_finite($countdownAt))
          $countdownAt = $tAlive;
        $expiresAt = is_finite($expiresAtRaw) ? $expiresAtRaw : ($countdownAt + $duration);
        if (!is_finite($expiresAt))
          $expiresAt = $countdownAt + $duration;
        if ($expiresAt <= $tAlive) {
          $riskAreasChanged = true;
          continue;
        }
        if (!is_finite($countdownAt))
          $countdownAt = $expiresAt - $duration;
        $duration = max($duration, $expiresAt - $countdownAt);
        $type = ($area['type'] ?? 'exp') === 'melon' ? 'melon' : 'exp';
        $riskAreas[] = [
          'x' => (float) ($area['x'] ?? 0),
          'y' => (float) ($area['y'] ?? 0),
          'r' => isset($area['r']) ? (float) $area['r'] : $RISK_AREA_RADIUS,
          'type' => $type,
          'countdownAt' => $countdownAt,
          'duration' => $duration,
          'expiresAt' => $expiresAt,
        ];
      }
    }
    if (count($riskAreas) !== count($state['riskAreas'] ?? []))
      $riskAreasChanged = true;
    $state['riskAreas'] = array_values($riskAreas);

    if (!is_array($riskEffect) && $riskEffect !== null)
      $riskEffect = null;
    if ($riskEffect === null && $riskIdx < count($riskEventTimes) && $tAlive >= $nextRiskAt && empty($riskAreas)) {
      if ($playerCount > 0) {
        $cx = 0.0; $cy = 0.0;
        foreach ($players as $p) { $cx += $p['x']; $cy += $p['y']; }
        $cx /= $playerCount; $cy /= $playerCount;
        $types = ['exp', 'melon'];
        $placed = [];
        foreach ($types as $type) {
          $best = null;
          $tries = 12;
          while ($tries-- > 0) {
            $dist = 650.0 + (mt_rand() / mt_getrandmax()) * 300.0;
            $ang = (mt_rand() / mt_getrandmax()) * M_PI * 2;
            $px = $cx + cos($ang) * $dist;
            $py = $cy + sin($ang) * $dist;
            if (!empty($stage['circular'])) {
              $radius = (float) ($stage['radius'] ?? 600.0);
              $maxR = max(0.0, $radius - $RISK_AREA_RADIUS);
              $d0 = hypot($px, $py);
              if ($d0 > $maxR) {
                if ($d0 > 0) {
                  $px = ($px / $d0) * $maxR;
                  $py = ($py / $d0) * $maxR;
                } else {
                  $px = $maxR;
                  $py = 0.0;
                }
              }
            }
            if (!empty($stage['star'])) {
              [$px, $py] = clamp_to_star($stage, $px, $py, $RISK_AREA_RADIUS);
            }
            if (($stage['type'] ?? 'plaza') === 'ranch') {
              $hh = (float) ($stage['halfHeight'] ?? 140);
              $py = max(-$hh + $RISK_AREA_RADIUS, min($hh - $RISK_AREA_RADIUS, $py));
            }
            $blocked = false;
            if (($stage['type'] ?? 'plaza') === 'maze' && empty($stage['ignoreMobWalls'])) {
              $obs = $getNearbyObstacles($px, $py);
              foreach ($obs as $rect) {
                if ($circleRectCollide($px, $py, $RISK_AREA_RADIUS, $rect)) {
                  $blocked = true;
                  break;
                }
              }
            }
            if ($blocked)
              continue;
            if (($stage['type'] ?? '') === 'volcano') {
              $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 25.0) * $tAlive);
              $px = max($px, $lavaX + $RISK_AREA_RADIUS + 1.0);
            }
            $minGap = $RISK_AREA_RADIUS * 1.8;
            $farEnough = true;
            foreach ($placed as $prev) {
              if (hypot($prev['x'] - $px, $prev['y'] - $py) < $minGap) {
                $farEnough = false;
                break;
              }
            }
            if (!$farEnough)
              continue;
            $best = [$px, $py];
            break;
          }
          if ($best === null) {
            $dist = 600.0 + (mt_rand() / mt_getrandmax()) * 300.0;
            $ang = (mt_rand() / mt_getrandmax()) * M_PI * 2;
            $px = $cx + cos($ang) * $dist;
            $py = $cy + sin($ang) * $dist;
            if (!empty($stage['circular'])) {
              $radius = (float) ($stage['radius'] ?? 600.0);
              $maxR = max(0.0, $radius - $RISK_AREA_RADIUS);
              $d0 = hypot($px, $py);
              if ($d0 > $maxR && $d0 > 0) {
                $px = ($px / $d0) * $maxR;
                $py = ($py / $d0) * $maxR;
              }
            }
            if (!empty($stage['star'])) {
              [$px, $py] = clamp_to_star($stage, $px, $py, $RISK_AREA_RADIUS);
            }
            if (($stage['type'] ?? 'plaza') === 'ranch') {
              $hh = (float) ($stage['halfHeight'] ?? 140);
              $py = max(-$hh + $RISK_AREA_RADIUS, min($hh - $RISK_AREA_RADIUS, $py));
            }
            if (($stage['type'] ?? '') === 'volcano') {
              $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 25.0) * $tAlive);
              $px = max($px, $lavaX + $RISK_AREA_RADIUS + 1.0);
            }
            $best = [$px, $py];
          }
          $placed[] = [
            'x' => (float) $best[0],
            'y' => (float) $best[1],
            'r' => $RISK_AREA_RADIUS,
            'type' => $type,
            'countdownAt' => $tAlive,
            'duration' => $RISK_EVENT_DURATION,
            'expiresAt' => $tAlive + $RISK_EVENT_DURATION,
          ];
        }
        if (!empty($placed)) {
          $riskIdx++;
          $state['riskEventIndex'] = $riskIdx;
          $state['nextRiskEventAt'] = $riskEventTimes[$riskIdx] ?? PHP_INT_MAX;
          $state['riskAreas'] = $placed;
          $state['riskAreaCountdownAckIndex'] = null;
          $riskAreas = $placed;
          $riskAreasChanged = true;
        }
      }
    }
    if ($riskAreasChanged) {
      $payloadAreas = array_map(function ($area) use ($RISK_EVENT_DURATION) {
        return [
          'x' => (float) ($area['x'] ?? 0),
          'y' => (float) ($area['y'] ?? 0),
          'r' => (float) ($area['r'] ?? 0),
          'type' => ($area['type'] ?? 'exp') === 'melon' ? 'melon' : 'exp',
          'countdownAt' => isset($area['countdownAt']) ? (float) $area['countdownAt'] : null,
          'duration' => isset($area['duration']) ? (float) $area['duration'] : $RISK_EVENT_DURATION,
          'expiresAt' => isset($area['expiresAt']) ? (float) $area['expiresAt'] : null,
        ];
      }, $state['riskAreas']);
      append_event($eventsDir, $roomId, [
        'type' => 'riskRewardAreas',
        'areas' => $payloadAreas,
        'eventIndex' => (int) ($state['riskEventIndex'] ?? 0),
        'svt' => $nowMs,
      ]);
    }

    // periodic mid-boss spawn (every 2.5 minutes)
    $nextMidBossAt = $state['nextMidBossAt'] ?? 150;
    $midBossRetry = (int) ($state['midBossRetry'] ?? 0);
    $nextBossAt = $state['nextBossAt'] ?? 360;
    $bossRetry = (int) ($state['bossRetry'] ?? 0);
    $nextReaperAt = $state['nextReaperAt'] ?? 900;
    $aliveCountsSnapshot = $state['aliveCounts'] ?? [];
    $anyBossAlive = !empty($aliveCountsSnapshot['hasBoss']);
    $bigBossAlive = !empty($aliveCountsSnapshot['hasBigBoss']);
    // Minimum time buffer between boss spawns (seconds)
    $MIN_BOSS_SPAWN_BUFFER = 1;
    if ($tAlive >= $nextMidBossAt) {
      if (($nextBossAt - $tAlive) > $MIN_BOSS_SPAWN_BUFFER && !$anyBossAlive) {
        pause_room_for_boss($roomsFile, $data, $ri, $roomId, $eventsDir);
        // fallback to 1 when players can't be counted to avoid division by zero
        $pc = max(1, $playerCount);
        $cx = 0;
        $cy = 0;
        foreach ($players as $p) {
          $cx += $p['x'];
          $cy += $p['y'];
        }
        $cx /= $pc;
        $cy /= $pc;
        $angle = (mt_rand() / mt_getrandmax()) * M_PI * 2;
        $radius = 340; // spawn closer to players
        $ex = $cx + cos($angle) * $radius;
        $ey = $cy + sin($angle) * $radius;
        $spawnR = 20.0;
        if (($stage['type'] ?? 'plaza') === 'ranch') {
          $hh = (float) ($stage['halfHeight'] ?? 140);
          $ey = max(-$hh + 24, min($hh - 24, $ey));
        } elseif (($stage['type'] ?? 'plaza') === 'maze') {
          $tries = 12;
          while ($tries-- > 0) {
            $obs = $getNearbyObstacles($ex, $ey);
            $blocked = false;
            foreach ($obs as $rect) {
              if ($circleRectCollide($ex, $ey, 20, $rect)) {
                $blocked = true;
                break;
              }
            }
            if (!$blocked) break;
            $ang2 = (mt_rand() / mt_getrandmax()) * M_PI * 2;
            $ex = $cx + cos($ang2) * $radius;
            $ey = $cy + sin($ang2) * $radius;
          }
        }
        if (($stage['type'] ?? '') === 'volcano') {
  $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 25.0) * $tAlive);
          $ex = max($ex, $lavaX + $spawnR + 1.0);
        }
        $timeFactor = (int) floor($tAlive / 600); // number of 10-minute intervals elapsed
        // scale mid-boss HP by number of active players
        $hpMax = (int) round((800 + (int) floor($tAlive * 1.5)) * pow(1.5, $timeFactor) * $diffHpMul * $diffMidBossHpMul * ($stage['midBossHpMul'] ?? 1) * 1.5 * $pc);
        $midBoss = [
          'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
          'type' => 'boss',
          'boss' => true,
          'name' => '中型個体',
          'x' => $ex,
          'y' => $ey,
          'r' => $spawnR,
          'hp' => $hpMax,
          'maxHp' => $hpMax,
          'spd' => 60,
          'alive' => true,
          't' => 0,
          'cd' => 1.0 / $diffBulletMul,
          'stompCd' => 4.0,
        ];
        if ($ignitionEnabled) {
          $midBoss['elem'] = pick_stage_element($stageName);
        }
        $state['enemies'][] = $midBoss;
        $adjustAliveCounts($midBoss, 1);
        // schedule next mid-boss strictly 2.5 minutes after the previous schedule
        $state['nextMidBossAt'] = $nextMidBossAt + 150;
        $state['midBossRetry'] = 0;
        /* resume deferred until boss is defeated */
      } elseif ($midBossRetry < 5) {
        $state['nextMidBossAt'] = $tAlive + 5;
        $state['midBossRetry'] = $midBossRetry + 1;
      } else {
        $state['nextMidBossAt'] = $nextMidBossAt + 150;
        $state['midBossRetry'] = 0;
      }
    }

    // periodic boss spawn (every 6 minutes)
    if ($tAlive >= $nextBossAt && (($nextMidBossAt - $tAlive) > 1)) {
      if (!$bigBossAlive) {
        pause_room_for_boss($roomsFile, $data, $ri, $roomId, $eventsDir);
        // fallback to 1 when players can't be counted
        $pc = max(1, $playerCount);
        // spawn boss slightly off players' centroid
        $cx = 0;
        $cy = 0;
        foreach ($players as $p) {
          $cx += $p['x'];
          $cy += $p['y'];
        }
        $cx /= $pc;
        $cy /= $pc;
        $angle = (mt_rand() / mt_getrandmax()) * M_PI * 2;
        $radius = 360; // spawn closer to players
        $ex = $cx + cos($angle) * $radius;
        $ey = $cy + sin($angle) * $radius;
        $spawnR = 22.0;
        if (($stage['type'] ?? 'plaza') === 'ranch') {
          $hh = (float) ($stage['halfHeight'] ?? 140);
          $ey = max(-$hh + 24, min($hh - 24, $ey));
        } elseif (($stage['type'] ?? 'plaza') === 'maze') {
          $tries = 12;
          while ($tries-- > 0) {
            $obs = $getNearbyObstacles($ex, $ey);
            $blocked = false;
            foreach ($obs as $rect) {
              if ($circleRectCollide($ex, $ey, 22, $rect)) {
                $blocked = true;
                break;
              }
            }
            if (!$blocked) break;
            $ang2 = (mt_rand() / mt_getrandmax()) * M_PI * 2;
            $ex = $cx + cos($ang2) * $radius;
            $ey = $cy + sin($ang2) * $radius;
          }
        }
        if (($stage['type'] ?? '') === 'volcano') {
  $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 25.0) * $tAlive);
          $ex = max($ex, $lavaX + $spawnR + 1.0);
        }
        $timeFactor = (int) floor($tAlive / 600);
        // scale boss HP by number of active players
        $hpMax = (int) round((1500 + (int) floor($tAlive * 2)) * pow(1.5, $timeFactor) * $diffHpMul * $diffBossHpMul * ($stage['bossHpMul'] ?? 1) * 1.5 * $pc);
        $bigBoss = [
          'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
          'type' => 'boss',
          'boss' => true,
          'name' => '大型個体',
          'x' => $ex,
          'y' => $ey,
          'r' => $spawnR,
          'hp' => $hpMax,
          'maxHp' => $hpMax,
          'spd' => 70,
          'alive' => true,
          't' => 0,
          'cd' => 1.0 / $diffBulletMul,
          'stompCd' => 4.0,
        ];
        if ($ignitionEnabled) {
          $bigBoss['elem'] = pick_stage_element($stageName);
        }
        $state['enemies'][] = $bigBoss;
        $adjustAliveCounts($bigBoss, 1);
        $state['nextBossAt'] = $nextBossAt + 360; // schedule next
        $state['bossRetry'] = 0;
        /* resume deferred until boss is defeated */
      } elseif ($bossRetry < 5) {
        $state['nextBossAt'] = $tAlive + 5;
        $state['bossRetry'] = $bossRetry + 1;
      } else {
        $state['nextBossAt'] = $nextBossAt + 360;
        $state['bossRetry'] = 0;
      }
    }

    // death reaper spawn (once at 15 minutes)
    // death reaper spawns regardless of other bosses
    if ($tAlive >= $nextReaperAt) {
      pause_room_for_boss($roomsFile, $data, $ri, $roomId, $eventsDir);
      $pc = max(1, $playerCount);
      $cx = 0; $cy = 0;
      foreach ($players as $p) { $cx += $p['x']; $cy += $p['y']; }
      $cx /= $pc; $cy /= $pc;
      for ($i = 0; $i < 3; $i++) {
        $angle = (mt_rand() / mt_getrandmax()) * M_PI * 2;
        $radius = 360;
        $ex = $cx + cos($angle) * $radius;
        $ey = $cy + sin($angle) * $radius;
        $spawnR = 22.0;
        if (($stage['type'] ?? 'plaza') === 'ranch') {
          $hh = (float) ($stage['halfHeight'] ?? 140);
          $ey = max(-$hh + 24, min($hh - 24, $ey));
        } elseif (($stage['type'] ?? 'plaza') === 'maze' && empty($stage['ignoreMobWalls'])) {
          $tries = 12;
          while ($tries-- > 0) {
            $obs = $getNearbyObstacles($ex, $ey);
            $blocked = false;
            foreach ($obs as $rect) {
              if ($circleRectCollide($ex, $ey, 20, $rect)) { $blocked = true; break; }
            }
            if (!$blocked) break;
            $ang2 = (mt_rand() / mt_getrandmax()) * M_PI * 2;
            $ex = $cx + cos($ang2) * $radius;
            $ey = $cy + sin($ang2) * $radius;
          }
        }
        if (($stage['type'] ?? '') === 'volcano') {
          $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 20.0) * $tAlive);
          $ex = max($ex, $lavaX + $spawnR + 1.0);
        }
        $reaperHp = (int) round(999999 * ($stage['mobHpMul'] ?? 1));
        $reaper = [
          'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
          'type' => 'reaper',
          'boss' => true,
          'name' => '死神',
          'elem' => 'dark',
          'x' => $ex,
          'y' => $ey,
          'r' => $spawnR,
          'hp' => $reaperHp,
          'maxHp' => $reaperHp,
          'spd' => 90,
          'alive' => true,
          't' => 0,
          'cd' => 1.0,
        ];
        $state['enemies'][] = $reaper;
        $adjustAliveCounts($reaper, 1);
      }
      $state['nextReaperAt'] = PHP_INT_MAX;
    }
    // Neutral wave spawns at fixed times (server-side)
    $nextNeutral = $state['nextNeutralWaveAt'] ?? PHP_INT_MAX;
    if (
      $nextNeutral !== PHP_INT_MAX &&
      $tAlive < $nextNeutral &&
      ($nextNeutral - $tAlive) <= 5 &&
      empty($state['neutralWaveWarned'])
    ) {
      append_event($eventsDir, $roomId, ['type' => 'neutralWaveWarning']);
      $state['neutralWaveWarned'] = true;
    }
    if ($tAlive >= $nextNeutral) {
      $spawned = 0;
      $pc = max(1, $playerCount);
      $maxEnemiesMap = ['かんたん' => 40, 'ふつう' => 60, 'むずかしい' => 80];
      $baseCount = (int) round(($maxEnemiesMap[$diffName] ?? 40) * 0.75);
      $count = (int) round($baseCount * $pc);
      $diffMul = (1 + min(1.8, $tAlive * 0.001)) * $diffHpMul * ($stage['mobHpMul'] ?? 1.0);
      $baseHp = 8 + (int) floor($tAlive / 20);
      $durabilityMul = 1 + (int) floor($tAlive / 120) * 0.1;
      $hp = (int) round($baseHp * $diffMul * $durabilityMul);
      $baseSpd = 40 + min(120.0, $tAlive * 0.08);
      $cx = 0; $cy = 0;
      foreach ($players as $p) { $cx += $p['x']; $cy += $p['y']; }
      $cx /= $pc; $cy /= $pc;
      for ($i = 0; $i < $count; $i++) {
        $angle = (mt_rand() / mt_getrandmax()) * M_PI * 2;
        $radius = 380.0;
        $ex = $cx + cos($angle) * $radius;
        $ey = $cy + sin($angle) * $radius;
        $spawnR = 9.0;
        if (($stage['type'] ?? 'plaza') === 'ranch') {
          $hh = (float) ($stage['halfHeight'] ?? 140);
          $ey = max(-$hh + 12, min($hh - 12, $ey));
        }
        if (($stage['type'] ?? 'plaza') === 'maze') {
          $tries = 8;
          while ($tries-- > 0) {
            $obs = $getNearbyObstacles($ex, $ey);
            $blocked = false;
            foreach ($obs as $rect) {
              if ($circleRectCollide($ex, $ey, 8.0, $rect)) { $blocked = true; break; }
            }
            if (!$blocked) break;
            $ang2 = (mt_rand() / mt_getrandmax()) * M_PI * 2;
            $ex = $cx + cos($ang2) * $radius;
            $ey = $cy + sin($ang2) * $radius;
          }
        }
        if (!empty($stage['star'])) {
          [$ex, $ey] = clamp_to_star($stage, $ex, $ey, $spawnR);
        }
        if (($stage['type'] ?? '') === 'volcano') {
          $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 20.0) * $tAlive);
          $ex = max($ex, $lavaX + $spawnR + 1.0);
        }
        $state['enemies'][] = [
          'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
          'type' => 'chaser',
          'x' => $ex,
          'y' => $ey,
          'r' => $spawnR,
          'hp' => $hp,
          'maxHp' => $hp,
          'spd' => $baseSpd,
          'alive' => true,
          't' => 0,
          'cd' => 0,
          'ttl' => 30,
        ];
        $spawned++;
      }
      if ($spawned > 0 || (($state['neutralWaveRetry'] ?? 0) >= 5)) {
        $idx = ((int) ($state['neutralWaveIndex'] ?? 0)) + 1;
        $state['neutralWaveIndex'] = $idx;
        $state['nextNeutralWaveAt'] = $state['neutralWaveTimes'][$idx] ?? PHP_INT_MAX;
        $state['neutralWaveRetry'] = 0;
        $state['neutralWaveWarned'] = false;
        if ($spawned > 0) {
          append_event($eventsDir, $roomId, [
            'type' => 'neutralWaveSpawn',
            'count' => $spawned,
          ]);
        }
      } else {
        $state['nextNeutralWaveAt'] = $tAlive + 5;
        $state['neutralWaveRetry'] = ($state['neutralWaveRetry'] ?? 0) + 1;
        $state['neutralWaveWarned'] = false;
      }
    }
    // Wave spawns (server-side): small packs at intervals, matching client pacing
    // This compensates for reduced perceived enemy count after moving to server authority
    if (($state['waveTimer'] ?? 0) <= 0) {
      // keep packs from becoming too frequent early; slow decrease over time
      $state['waveTimer'] = max(10.0, 16.0 - $tAlive * 0.005) / $diffSpawnMul;
      if ($tAlive > 30.0) {
        // choose pack size based on survival time
        $count = 1 + (int) floor(mt_rand() / mt_getrandmax() * 2);
        if ($tAlive > 150.0)
          $count = 3 + (int) floor(mt_rand() / mt_getrandmax() * 2);
        elseif ($tAlive > 90.0)
          $count = 2 + (int) floor(mt_rand() / mt_getrandmax() * 2);
        $count = (int) round($count * $diffSpawnMul);
        // spawn around players' centroid with gentle type mix progression
        $cx = 0;
        $cy = 0;
        foreach ($players as $p) {
          $cx += $p['x'];
          $cy += $p['y'];
        }
        $cx /= $playerCount;
        $cy /= $playerCount;
        for ($i = 0; $i < $count; $i++) {
          $ang = (mt_rand() / mt_getrandmax()) * M_PI * 2;
          $r = 420 + (mt_rand() / mt_getrandmax()) * 60;
          $ex = $cx + cos($ang) * $r;
          $ey = $cy + sin($ang) * $r;
          $spawnR = 9.0;
          // ranch clamp / maze obstacle avoid (few tries)
          if (($stage['type'] ?? 'plaza') === 'ranch') {
            $hh = (float) ($stage['halfHeight'] ?? 140);
            $ey = max(-$hh + 12, min($hh - 12, $ey));
          }
          if (($stage['type'] ?? 'plaza') === 'maze') {
            $tries = 8;
            while ($tries-- > 0) {
              $obs = $getNearbyObstacles($ex, $ey);
              $blocked = false;
              foreach ($obs as $rect) {
                if ($circleRectCollide($ex, $ey, 8.0, $rect)) {
                  $blocked = true;
                  break;
                }
              }
              if (!$blocked)
                break;
              $ang2 = (mt_rand() / mt_getrandmax()) * M_PI * 2;
              $ex = $cx + cos($ang2) * $r;
              $ey = $cy + sin($ang2) * $r;
            }
          }
          if (($stage['type'] ?? '') === 'volcano') {
            $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 20.0) * $tAlive);
            $ex = max($ex, $lavaX + $spawnR + 1.0);
          }
          // type mix progression
          $roll = (mt_rand() / mt_getrandmax());
          $etype = 'chaser';
          if ($tAlive <= 60.0) {
            $etype = ($roll < 0.3) ? 'zig' : 'chaser';
          } elseif ($tAlive <= 90.0) {
            $etype = ($roll < 0.6) ? 'zig' : 'chaser';
          } elseif ($tAlive <= 150.0) {
            if ($roll < 0.10)
              $etype = 'shooter';
            else
              $etype = ($roll < 0.65 ? 'zig' : 'chaser');
          } else { // >150s
            if ($roll < 0.40)
              $etype = 'shooter';
            else
              $etype = ($roll < 0.8 ? 'zig' : 'chaser');
          }
          $baseHp = 10.0 + $tAlive / 30.0;
          $hp = (int) round($baseHp * (1.0 + $tAlive * 0.001) * $diffHpMul);
          $e = [
            'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
            'type' => $etype,
            'x' => $ex,
            'y' => $ey,
            'r' => $spawnR,
            'spd' => 70,
            'hp' => $hp,
            'maxHp' => $hp,
            'alive' => true,
            't' => 0,
            'cd' => 0,
          ];
          if ($etype === 'shooter') {
            $e['cd'] = (2.8 + (mt_rand() / mt_getrandmax()) * 1.5) / $diffBulletMul;
            $e['range'] = 300;
          }
          if ($etype === 'zig') {
            $e['phase'] = (mt_rand() / mt_getrandmax()) * M_PI * 2;
          }
          if ((mt_rand() / mt_getrandmax()) < $elemChance) {
            $e['elem'] = $elementTypes[array_rand($elementTypes)];
          }
          $state['enemies'][] = $e;
        }
      }
    }
    // Density booster: ensure each player has a minimum number of nearby enemies
    // (helps perceived density in server authority)
    {
      $desiredNear = max(6, min(28, (8 + (int) floor($tAlive / 15)) * $diffSpawnMul)); // scaled by difficulty
      $maxBoostPerTick = 2; // avoid sudden spikes
      $boosted = 0;
      foreach ($players as $p0) {
        $near = 0;
        foreach ($state['enemies'] as $ee) {
          if (empty($ee['alive']))
            continue;
          if (hypot($ee['x'] - $p0['x'], $ee['y'] - $p0['y']) <= 600.0) {
            $near++;
            if ($near >= $desiredNear)
              break;
          }
        }
        if ($near >= $desiredNear)
          continue;
        $need = min($desiredNear - $near, $maxBoostPerTick - $boosted);
        for ($bi = 0; $bi < $need; $bi++) {
          // spawn a basic unit off the player position
          $ang = (mt_rand() / mt_getrandmax()) * M_PI * 2;
          $r = 360 + (mt_rand() / mt_getrandmax()) * 140;
          $ex = $p0['x'] + cos($ang) * $r;
          $ey = $p0['y'] + sin($ang) * $r;
          $spawnR = 9.0;
          // ranch clamp / maze avoid few tries
          if (($stage['type'] ?? 'plaza') === 'ranch') {
            $hh = (float) ($stage['halfHeight'] ?? 140);
            $ey = max(-$hh + 12, min($hh - 12, $ey));
          }
          if (($stage['type'] ?? 'plaza') === 'maze') {
            $tries = 6;
            while ($tries-- > 0) {
              $obs = $getNearbyObstacles($ex, $ey);
              $blocked = false;
              foreach ($obs as $rect) {
                if ($circleRectCollide($ex, $ey, 8.0, $rect)) {
                  $blocked = true;
                  break;
                }
              }
              if (!$blocked)
                break;
              $ang2 = (mt_rand() / mt_getrandmax()) * M_PI * 2;
              $ex = $p0['x'] + cos($ang2) * $r;
              $ey = $p0['y'] + sin($ang2) * $r;
            }
          }
          if (($stage['type'] ?? '') === 'volcano') {
            $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 20.0) * $tAlive);
            $ex = max($ex, $lavaX + $spawnR + 1.0);
          }
          $hp = max(1, (int) round((8 + (int) floor($tAlive / 20)) * (1 + min(1.8, $tAlive * 0.001)) * $diffHpMul));
          $e = [
            'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
            'type' => 'chaser',
            'x' => $ex,
            'y' => $ey,
            'r' => $spawnR,
            'spd' => (40 + min(120, $tAlive * 0.08)),
            'hp' => $hp,
            'maxHp' => $hp,
            'alive' => true,
            't' => 0,
            'cd' => 0,
          ];
          if ((mt_rand() / mt_getrandmax()) < $elemChance) {
            $e['elem'] = $elementTypes[array_rand($elementTypes)];
          }
          $state['enemies'][] = $e;
          $boosted++;
          if ($boosted >= $maxBoostPerTick)
            break 2;
        }
      }
    }

    // Token-bucket style rate limiters for projectiles/hazards
    $rate = $state['rate'] ?? ['pTok' => 160.0, 'pCap' => 200.0, 'pRefill' => 120.0, 'hTok' => 24.0, 'hCap' => 40.0, 'hRefill' => 16.0];
    $rate['pTok'] = min((float) ($rate['pCap'] ?? 200), (float) ($rate['pTok'] ?? 0) + (float) ($rate['pRefill'] ?? 100) * $dt);
    $rate['hTok'] = min((float) ($rate['hCap'] ?? 40), (float) ($rate['hTok'] ?? 0) + (float) ($rate['hRefill'] ?? 16) * $dt);
    $state['rate'] = $rate;

    // count existing barrage projectiles to cap total amount
    $barrageCount = 0;
    foreach ($state['projectiles'] as $b) {
      $bType = $b['type'] ?? '';
      if ($bType === 'barrage') {
        $barrageCount++;
      }
    }

    // update enemies: movement + attacks (server-authoritative behaviors)
    $lavaX = null;
    if (($stage['type'] ?? '') === 'volcano')
      $lavaX = -600.0 + (($stage['lavaSpeed'] ?? 20.0) * $tAlive);
    foreach ($state['enemies'] as &$e) {
      if (empty($e['alive']))
        continue;
      if (($e['stun'] ?? 0) > 0) { $e['stun'] -= $dt; continue; }
      $e['t'] = ($e['t'] ?? 0) + $dt;
      $e['cd'] = ($e['cd'] ?? 0) - $dt;
      $skipDecoys = !empty($e['boss']);
      [$tgt, $d] = $nearest($e['x'], $e['y'], $skipDecoys);
      $d = max(1e-3, $d);
      $dx = $tgt['x'] - $e['x'];
      $dy = $tgt['y'] - $e['y'];
      $nx = $e['x'];
      $ny = $e['y'];
      $spd = (float) ($e['spd'] ?? 60);
      $typ = $e['type'] ?? 'chaser';
      $applyStageMove = function ($oldX, $oldY, $nx, $ny, $r) use ($stage, $getNearbyObstacles, $circleRectCollide, $clamp) {
        $x = $oldX;
        $y = $oldY;
        if (($stage['type'] ?? 'plaza') === 'ranch') {
          $y = $clamp($ny, -($stage['halfHeight'] ?? 140) + $r, ($stage['halfHeight'] ?? 140) - $r);
          $x = $nx;
        } elseif (($stage['type'] ?? 'plaza') === 'maze' && empty($stage['ignoreMobWalls'])) {
          $obs = $getNearbyObstacles($nx, $oldY);
          $blockedX = false;
          foreach ($obs as $rect) {
            if ($circleRectCollide($nx, $oldY, $r, $rect)) {
              $blockedX = true;
              break;
            }
          }
          if (!$blockedX)
            $x = $nx;
          $obsY = $getNearbyObstacles($x, $ny);
          $blockedY = false;
          foreach ($obsY as $rect) {
            if ($circleRectCollide($x, $ny, $r, $rect)) {
              $blockedY = true;
              break;
            }
          }
          if (!$blockedY)
            $y = $ny;
        } else {
          $x = $nx;
          $y = $ny;
        }
        if (!empty($stage['star'])) {
          [$x, $y] = clamp_to_star($stage, $x, $y, $r);
        }
        return [$x, $y];
      };
      switch ($typ) {
        case 'boss':
          // slow approach
          $nx = $e['x'] + ($dx / $d) * $spd * 0.75 * $dt;
          $ny = $e['y'] + ($dy / $d) * $spd * 0.75 * $dt;
          [$nx, $ny] = $applyStageMove($e['x'], $e['y'], $nx, $ny, (float) ($e['r'] ?? 12));
          // radial bullet ring
          if (($e['cd'] ?? 0) <= 0) {
            $e['cd'] = 1.8 / $diffBulletMul;
            $n = max(1, (int) round(12 * $diffBulletMul));
            $baseSpd = 200 + min(200, $tAlive * 0.2);
            $dmg = max(1, (int) round((6 + (int) floor($tAlive / 120)) * $diffBulletDmgMul));
            $offset = fmod(($e['t'] ?? 0) * 0.8, M_PI * 2);
            // rate-limit and cull far spawns
            $minDist = $distToPlayers($e['x'], $e['y'], $players);
            $SPAWN_CULL = 1200.0;
            if ($minDist <= $SPAWN_CULL && ($state['rate']['pTok'] ?? 0) > 0) {
              $can = (int) min($n, floor(($state['rate']['pTok'] ?? 0)));
              for ($k = 0; $k < $can; $k++) {
                $ang = $offset + (M_PI * 2 * $k) / $n;
                $state['projectiles'][] = [
                  'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
                  'type' => 'boss',
                  'x' => $e['x'],
                  'y' => $e['y'],
                  'vx' => cos($ang) * $baseSpd,
                  'vy' => sin($ang) * $baseSpd,
                  'r' => 4,
                  'ttl' => 2.6,
                  'dmg' => $dmg,
                  'arm' => 0.12
                ];
              }
              $state['rate']['pTok'] -= $can;
            }
          }
          // dense bullet barrage every 20 seconds
          $e['barrageCd'] = ($e['barrageCd'] ?? 20.0) - $dt;
          if (($e['barrageCd'] ?? 0) <= 0) {
            $e['barrageCd'] = 20.0;
            $n = max(1, (int) round(40 * $diffBulletMul));
            $baseSpd = 120;
            $dmg = max(1, (int) round((5 + (int) floor($tAlive / 150)) * $diffBulletDmgMul));
            $offset = fmod(($e['t'] ?? 0), M_PI * 2);
            $minDist = $distToPlayers($e['x'], $e['y'], $players);
            $SPAWN_CULL = 1200.0;
            if ($minDist <= $SPAWN_CULL && ($state['rate']['pTok'] ?? 0) > 0) {
              $can = (int) min($n, floor(($state['rate']['pTok'] ?? 0)));
              for ($k = 0; $k < $can; $k++) {
                $ang = $offset + (M_PI * 2 * $k) / $n;
                $state['projectiles'][] = [
                  'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
                  'type' => 'boss',
                  'x' => $e['x'],
                  'y' => $e['y'],
                  'vx' => cos($ang) * $baseSpd,
                  'vy' => sin($ang) * $baseSpd,
                  'r' => 4,
                  'ttl' => 4.5,
                  'dmg' => $dmg,
                  'arm' => 0.12
                ];
              }
              $state['rate']['pTok'] -= $can;
            }
          }
          // stomp AoE when close
          $e['stompCd'] = ($e['stompCd'] ?? 3.5) - $dt;
          if (($e['stompCd'] ?? 0) <= 0 && $d < 140) {
            $e['stompCd'] = 4.0;
            // Send a telegraph first (closer to client behavior)
            $minDist = $distToPlayers($e['x'], $e['y'], $players);
            if ($minDist <= 1200.0 && ($state['rate']['hTok'] ?? 0) >= 1) {
              $state['hazards'][] = [
                'type' => 'telegraph',
                'x' => $e['x'],
                'y' => $e['y'],
                'r' => 80,
                'tele' => 0.6,
                'dmg' => 24 + (int) floor($tAlive / 150),
                'next' => ['r' => 80, 'ttl' => 0.16]
              ];
              $state['rate']['hTok'] -= 1;
            }
          }
          break;
        case 'zig':
          $ang = atan2($dy, $dx) + sin(($e['t'] ?? 0) * 4 + ($e['phase'] ?? 0)) * 0.6;
          $nx = $e['x'] + cos($ang) * $spd * $dt;
          $ny = $e['y'] + sin($ang) * $spd * $dt;
          [$nx, $ny] = $applyStageMove($e['x'], $e['y'], $nx, $ny, (float) ($e['r'] ?? 9));
          break;
        case 'shooter':
          $want = isset($e['range']) ? (float) $e['range'] : 300.0;
          $toMe = atan2($dy, $dx);
          $side = $toMe + M_PI / 2;
          $toward = ($d > $want) ? 1.0 : (($d < $want * 0.7) ? -0.7 : 0.0);
          $nx = $e['x'] + (cos($toMe) * $spd * $toward + cos($side) * $spd * 0.5 * sin(($e['t'] ?? 0) * 2 + ($e['phase'] ?? 0))) * $dt;
          $ny = $e['y'] + (sin($toMe) * $spd * $toward + sin($side) * $spd * 0.5 * sin(($e['t'] ?? 0) * 2 + ($e['phase'] ?? 0))) * $dt;
          [$nx, $ny] = $applyStageMove($e['x'], $e['y'], $nx, $ny, (float) ($e['r'] ?? 9));
          if (($e['cd'] ?? 0) <= 0 && $d < $want + 40) {
            // LoS check in maze, and rate/distance controls
            if (!$hasWallBetween($e['x'], $e['y'], $tgt['x'], $tgt['y'])) {
              $minDist = $distToPlayers($e['x'], $e['y'], $players);
              if ($minDist <= 1200.0 && ($state['rate']['pTok'] ?? 0) >= 1) {
                $e['cd'] = (2.8 + (mt_rand() / mt_getrandmax()) * 1.5) / $diffBulletMul;
                $bSpd = 180 + min(180, $tAlive * 0.2);
                $dmg = max(1, (int) round((3 + (int) floor($tAlive / 180)) * $diffBulletDmgMul));
                $state['projectiles'][] = ['id' => substr(bin2hex(safe_random_bytes(6)), 0, 8), 'type' => 'shooter', 'x' => $e['x'], 'y' => $e['y'], 'vx' => ($dx / $d) * $bSpd, 'vy' => ($dy / $d) * $bSpd, 'r' => 4, 'ttl' => 2.2, 'dmg' => $dmg, 'arm' => 0.08];
                $state['rate']['pTok'] -= 1;
              }
            }
          }
          break;
        case 'dasher':
          $stateName = $e['state'] ?? 'stalk';
          if ($stateName === 'stalk') {
            $nx = $e['x'] + ($dx / $d) * $spd * 0.85 * $dt;
            $ny = $e['y'] + ($dy / $d) * $spd * 0.85 * $dt;
            [$nx, $ny] = $applyStageMove($e['x'], $e['y'], $nx, $ny, (float) ($e['r'] ?? 9));
            if ($d < 180 && ($e['cd'] ?? 0) <= 0) {
              $e['state'] = 'wind';
              $e['dash']['wind'] = 0.3;
              $v = 320 + min(220, $tAlive * 0.2);
              $e['dash']['vx'] = ($dx / $d) * $v;
              $e['dash']['vy'] = ($dy / $d) * $v;
            }
          } elseif ($stateName === 'wind') {
            $e['dash']['wind'] = ($e['dash']['wind'] ?? 0) - $dt;
            if (($e['dash']['wind'] ?? 0) <= 0) {
              $e['state'] = 'dash';
              $e['dash']['time'] = 0.22;
            }
          } elseif ($stateName === 'dash') {
            $nx = $e['x'] + ($e['dash']['vx'] ?? 0) * $dt;
            $ny = $e['y'] + ($e['dash']['vy'] ?? 0) * $dt;
            // collide with walls in maze to stop quickly
            if (($stage['type'] ?? 'plaza') === 'maze' && empty($stage['ignoreMobWalls'])) {
              $obs = $getNearbyObstacles($nx, $ny);
              $hitWall = false;
              foreach ($obs as $rect) {
                if ($circleRectCollide($nx, $ny, (float) ($e['r'] ?? 9), $rect)) {
                  $hitWall = true;
                  break;
                }
              }
              if ($hitWall) {
                $e['state'] = 'stalk';
                $e['cd'] = 1.0;
              }
            }
            $e['dash']['time'] = ($e['dash']['time'] ?? 0) - $dt;
            if (($e['dash']['time'] ?? 0) <= 0) {
              $e['state'] = 'stalk';
              $e['cd'] = 0.8;
            }
          }
          break;
        case 'bomber':
          $nx = $e['x'] + ($dx / $d) * $spd * 0.8 * $dt;
          $ny = $e['y'] + ($dy / $d) * $spd * 0.8 * $dt;
          [$nx, $ny] = $applyStageMove($e['x'], $e['y'], $nx, $ny, (float) ($e['r'] ?? 9));
          if ($d < 70 && ($e['fuse'] ?? -1) < 0) {
            $e['fuse'] = $e['blast']['fuseTime'] ?? 0.8;
            // Emit telegraph when fuse starts (server authority UX)
            $minDist = $distToPlayers($e['x'], $e['y'], $players);
            if ($minDist <= 1200.0 && ($state['rate']['hTok'] ?? 0) >= 1) {
              $state['hazards'][] = [
                'type' => 'telegraph',
                'x' => $e['x'],
                'y' => $e['y'],
                'r' => ($e['blast']['r'] ?? 56),
                'tele' => (float) $e['fuse'],
                'dmg' => 12 + (int) floor($tAlive / 200),
                'fx' => 'bomber',
                'next' => ['r' => ($e['blast']['r'] ?? 56), 'ttl' => 0.12, 'maxTtl' => 0.12, 'fx' => 'bomber']
              ];
              $state['rate']['hTok'] -= 1;
            }
          }
          if (($e['fuse'] ?? -1) >= 0) {
            $e['fuse'] -= $dt;
            if (($e['fuse'] ?? 0) <= 0) {
              // Explosion is handled client-side after telegraph; mark dead here
              if (!empty($e['alive']) && vlg_should_track_alive_counts($e))
                $adjustAliveCounts($e, -1);
              $e['alive'] = false;
            }
          }
          break;
        case 'reaper':
          $nx = $e['x'] + ($dx / $d) * $spd * 1.0 * $dt;
          $ny = $e['y'] + ($dy / $d) * $spd * 1.0 * $dt;
          [$nx, $ny] = $applyStageMove($e['x'], $e['y'], $nx, $ny, (float) ($e['r'] ?? 9));
          // ensure movement is applied before firing logic
          $e['x'] = $nx;
          $e['y'] = $ny;
          if (($e['cd'] ?? 0) <= 0) {
            $minDist = $distToPlayers($e['x'], $e['y'], $players);
            if ($minDist <= 1200.0 && ($state['rate']['pTok'] ?? 0) >= 1) {
              $e['cd'] = 0.6;
              $bSpd = 180;
              $state['projectiles'][] = [
                'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
                'type' => 'boss',
                'x' => $e['x'],
                'y' => $e['y'],
                'vx' => ($dx / $d) * $bSpd,
                'vy' => ($dy / $d) * $bSpd,
                'r' => 4,
                'ttl' => 1.6,
                'dmg' => 40,
                'arm' => 0.08
              ];
              $state['rate']['pTok'] -= 1;
            }
          }
          $e['snipeCd'] = ($e['snipeCd'] ?? 2.3) - $dt;
          if (($e['snipeCd'] ?? 0) <= 0) {
            $minDist = $distToPlayers($e['x'], $e['y'], $players);
            if ($minDist <= 1200.0 && ($state['rate']['pTok'] ?? 0) >= 1) {
              $e['snipeCd'] = 2.3;
              $bSpd = 800;
              $state['projectiles'][] = [
                'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
                'type' => 'boss',
                'x' => $e['x'],
                'y' => $e['y'],
                'vx' => ($dx / $d) * $bSpd,
                'vy' => ($dy / $d) * $bSpd,
                'r' => 3,
                'ttl' => 2.0,
                'dmg' => 200,
                'arm' => 0.12
              ];
              $state['rate']['pTok'] -= 1;
            }
          }
          break;
        case 'barrage':
          $moveSpd = (float) ($e['spd'] ?? 40);
          $e['wanderTimer'] = ($e['wanderTimer'] ?? 0) - $dt;
          if (($e['wanderTimer'] ?? 0) <= 0) {
            $e['wanderTimer'] = 2.5 + (mt_rand() / mt_getrandmax()) * 2.5;
            $e['wanderAng'] = (mt_rand() / mt_getrandmax()) * M_PI * 2;
          }
          $wanderAng = (float) ($e['wanderAng'] ?? 0);
          $nx = $e['x'] + cos($wanderAng) * $moveSpd * $dt;
          $ny = $e['y'] + sin($wanderAng) * $moveSpd * $dt;
          [$nx, $ny] = $applyStageMove($e['x'], $e['y'], $nx, $ny, (float) ($e['r'] ?? 12));
          $minDist = $distToPlayers($nx, $ny, $players);
          $limit = isset($e['bulletLimit']) ? (int) $e['bulletLimit'] : 180;
          if (isset($e['interval'])) {
            $e['cd'] = ($e['cd'] ?? (float) $e['interval']) - $dt;
            if (($e['cd'] ?? 0) <= 0) {
              $volley = max(6, (int) round($e['volley'] ?? 12));
              $rings = max(1, (int) round($e['rings'] ?? 1));
              $bulletSpd = (float) ($e['bulletSpd'] ?? 100);
              $ttl = (float) ($e['bulletTtl'] ?? 5.5);
              $dmg = max(1, (int) round(($e['bulletDmg'] ?? 6) * $diffBulletDmgMul));
              $phase = isset($e['patternPhase']) ? (float) $e['patternPhase'] : ((mt_rand() / mt_getrandmax()) * M_PI * 2);
              $phase += 0.35;
              $e['patternPhase'] = $phase;
              $maxShots = max(0, $limit - $barrageCount);
              $tokenAvail = (int) floor($state['rate']['pTok'] ?? 0);
              $totalShots = $volley * $rings;
              $shotsToFire = min($maxShots, $totalShots, $tokenAvail);
              if ($shotsToFire > 0 && $minDist <= 1200.0) {
                $fired = 0;
                for ($r = 0; $r < $rings && $fired < $shotsToFire; $r++) {
                  $offset = $phase + ($r * M_PI) / max(1, $rings);
                  for ($k = 0; $k < $volley && $fired < $shotsToFire; $k++) {
                    $ang = $offset + (M_PI * 2 * $k) / max(1, $volley);
                    $state['projectiles'][] = [
                      'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
                      'type' => 'barrage',
                      'x' => $e['x'],
                      'y' => $e['y'],
                      'vx' => cos($ang) * $bulletSpd,
                      'vy' => sin($ang) * $bulletSpd,
                      'r' => 4,
                      'ttl' => $ttl,
                      'dmg' => $dmg,
                      'arm' => 0.25,
                    ];
                    $fired++;
                    $barrageCount++;
                  }
                }
                $state['rate']['pTok'] -= $fired;
              }
              $e['cd'] = max(0.4, (float) $e['interval']);
            }
          }
          if (isset($e['sprayInterval'])) {
            $e['sprayCd'] = ($e['sprayCd'] ?? (float) $e['sprayInterval']) - $dt;
            if (($e['sprayCd'] ?? 0) <= 0) {
              $shots = max(3, (int) round($e['sprayShots'] ?? 4));
              $fan = (float) ($e['fan'] ?? 0.4);
              $spraySpeed = (float) ($e['spraySpeed'] ?? (($e['bulletSpd'] ?? 100) * 0.8));
              $ttl = (float) (($e['bulletTtl'] ?? 5.5) * 0.8);
              $dmg = max(1, (int) round(($e['sprayDmg'] ?? ($e['bulletDmg'] ?? 6)) * $diffBulletDmgMul));
              $maxShots = max(0, $limit - $barrageCount);
              $shotsAvail = min($shots, $maxShots, (int) floor($state['rate']['pTok'] ?? 0));
              if ($shotsAvail > 0 && $minDist <= 1200.0) {
                for ($k = 0; $k < $shotsAvail; $k++) {
                  $ratio = $shotsAvail > 1 ? ($k / ($shotsAvail - 1)) - 0.5 : 0.0;
                  $ang = atan2($dy, $dx) + $fan * $ratio;
                  $state['projectiles'][] = [
                    'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
                    'type' => 'barrage',
                    'x' => $e['x'],
                    'y' => $e['y'],
                    'vx' => cos($ang) * $spraySpeed,
                    'vy' => sin($ang) * $spraySpeed,
                    'r' => 4,
                    'ttl' => $ttl,
                    'dmg' => $dmg,
                    'arm' => 0.15,
                  ];
                  $barrageCount++;
                }
                $state['rate']['pTok'] -= $shotsAvail;
              }
              $e['sprayCd'] = max(0.3, (float) $e['sprayInterval']);
            }
          }
          break;
        default: // chaser
          $nx = $e['x'] + ($dx / $d) * $spd * $dt;
          $ny = $e['y'] + ($dy / $d) * $spd * $dt;
          [$nx, $ny] = $applyStageMove($e['x'], $e['y'], $nx, $ny, (float) ($e['r'] ?? 9));
      }
      $e['x'] = $nx;
      $e['y'] = $ny;
      if ($lavaX !== null && $e['x'] < $lavaX) {
        if (!empty($e['boss'])) {
          $e['x'] = $lavaX + ((float) ($e['r'] ?? 9.0)) + 1.0;
        } else {
          $e['hp'] = 0.0;
          if (!empty($e['alive']) && vlg_should_track_alive_counts($e))
            $adjustAliveCounts($e, -1);
          $e['alive'] = false;
        }
      }
    }
    unset($e);
    // thin out far/invalid and collect deaths
    $kept = [];
    $deadEvents = [];
    foreach ($state['enemies'] as $e) {
      if (!is_finite($e['x']) || !is_finite($e['y']))
        continue;
      if (!empty($e['alive'])) {
        $kept[] = $e; // keep alive
      } else {
        $deadEvents[] = $e; // record for event
      }
    }
    $state['enemies'] = $kept;

    // emit enemyDead events
    foreach ($deadEvents as $e) {
      $payload = [
        'type' => 'enemyDead',
        'id' => $e['id'] ?? null,
        'x' => (float) ($e['x'] ?? 0),
        'y' => (float) ($e['y'] ?? 0),
      ];
      if (!empty($e['boss']))
        $payload['boss'] = true;
      append_event($eventsDir, $roomId, $payload);
    }

    // update projectiles (move, ttl, maze collision, far culling)
    $keptB = [];
    foreach ($state['projectiles'] as $b) {
      $b['ttl'] = isset($b['ttl']) ? ((float) $b['ttl'] - $dt) : 0.0;
      if (($b['ttl'] ?? 0) <= 0)
        continue;
      $b['x'] = (float) ($b['x'] ?? 0) + (float) ($b['vx'] ?? 0) * $dt;
      $b['y'] = (float) ($b['y'] ?? 0) + (float) ($b['vy'] ?? 0) * $dt;
      if (isset($b['arm'])) {
        $b['arm'] = max(0, (float) $b['arm'] - $dt);
      }
      // maze: collide with walls and drop
      if (($stage['type'] ?? 'plaza') === 'maze') {
        $obs = $getNearbyObstacles($b['x'], $b['y']);
        $hit = false;
        foreach ($obs as $rect) {
          if ($circleRectCollide((float) $b['x'], (float) $b['y'], (float) ($b['r'] ?? 3), $rect)) {
            $hit = true;
            break;
          }
        }
        if ($hit)
          continue;
      }
      // far culling from all players
      if ($distToPlayers((float) $b['x'], (float) $b['y'], $players) > 1600.0)
        continue;
      $keptB[] = $b;
    }
    $state['projectiles'] = $keptB;

    // update hazards: ttl, and convert telegraphs -> explosions
    $keptH = [];
    foreach ($state['hazards'] as $h) {
      // special: telegraph has both ttl (draw lifetime) and tele (countdown to explosion)
      if (($h['type'] ?? '') === 'telegraph') {
        if (isset($h['tele'])) {
          $h['tele'] = (float) $h['tele'] - $dt;
          if ($h['tele'] <= 0) {
            // spawn an explosion hazard using 'next' or defaults
            $nx = is_array($h['next'] ?? null) ? $h['next'] : [];
            $r2 = (float) ($nx['r'] ?? ($h['r'] ?? 80));
            $ttl2 = (float) ($nx['ttl'] ?? 0.14);
            $dmg2 = (float) ($h['dmg'] ?? 18);
            // only keep explosion if not too far
            if ($distToPlayers((float) ($h['x'] ?? 0), (float) ($h['y'] ?? 0), $players) <= 1600.0) {
              $keptH[] = ['type' => 'explosion', 'x' => (float) ($h['x'] ?? 0), 'y' => (float) ($h['y'] ?? 0), 'r' => $r2, 'ttl' => $ttl2, 'dmg' => $dmg2];
            }
            // drop telegraph itself
            continue;
          }
        }
        // fallthrough to ttl processing for telegraph visual
      }
      $h['ttl'] = isset($h['ttl']) ? ((float) $h['ttl'] - $dt) : 0.0;
      if (($h['ttl'] ?? 0) <= 0)
        continue;
      if ($distToPlayers((float) ($h['x'] ?? 0), (float) ($h['y'] ?? 0), $players) > 1600.0)
        continue;
      $keptH[] = $h;
    }
$state['hazards'] = $keptH;

// Auto-resume when no boss remains alive
$hasBossAlive = !empty(($state['aliveCounts']['hasBoss'] ?? false));
if (!$hasBossAlive && !empty($room['pauseBy']) && in_array('boss', ($room['pauseBy'] ?? []), true)) {
  resume_room_after_boss($roomsFile, $data, $ri, $roomId, $eventsDir);
}

write_state($stateDir, $roomId, $state);
    // emit snapshot up to ~15Hz
    $lastEmitMs = (int) ($state['lastEmitMs'] ?? 0);
    if ($nowMs - $lastEmitMs >= 67) {
      $state['lastEmitMs'] = $nowMs;
      // ensure enemy list is unique by id
      $uniq = [];
      foreach ($state['enemies'] as $e) {
        $uniq[$e['id']] = $e;
      }
      if (count($uniq) !== count($state['enemies'])) {
        $log->debug('simulate_enemies:duplicateEnemies', ['roomId' => $roomId]);
      }
      $state['enemies'] = array_values($uniq);
      write_state($stateDir, $roomId, $state);
      $snapshot = [
        'type' => 'svEnemies',
        'svt' => $nowMs,
        'enemies' => array_map(function ($e) {
          return [
            'id' => $e['id'],
            'type' => $e['type'],
            'x' => (float) $e['x'],
            'y' => (float) $e['y'],
            'r' => (float) $e['r'],
            'hp' => isset($e['hp']) ? (float) $e['hp'] : null,
            'maxHp' => isset($e['maxHp']) ? (float) $e['maxHp'] : null,
            'boss' => !empty($e['boss']) ? true : false,
            'name' => isset($e['name']) ? (string) $e['name'] : null,
            'elem' => isset($e['elem']) ? $e['elem'] : null,
            'dmgTakenMul' => isset($e['dmgTakenMul']) ? (float) $e['dmgTakenMul'] : null,
            // extra fields for client telegraphs in serverSim
            'state' => isset($e['state']) ? (string) $e['state'] : null,
            'fuse' => isset($e['fuse']) ? (float) $e['fuse'] : null,
            'blast' => isset($e['blast']) ? $e['blast'] : null,
          ];
        }, $state['enemies']),
        'bullets' => array_map(function ($b) {
          return [
            'id' => $b['id'] ?? substr(bin2hex(safe_random_bytes(6)), 0, 8),
            'type' => $b['type'] ?? 'enemy',
            'x' => (float) ($b['x'] ?? 0),
            'y' => (float) ($b['y'] ?? 0),
            'vx' => (float) ($b['vx'] ?? 0),
            'vy' => (float) ($b['vy'] ?? 0),
            'r' => (float) ($b['r'] ?? 3),
            'ttl' => isset($b['ttl']) ? (float) $b['ttl'] : 0,
            'dmg' => isset($b['dmg']) ? (float) $b['dmg'] : 1,
            'arm' => isset($b['arm']) ? (float) $b['arm'] : 0,
          ];
        }, $state['projectiles']),
        'hazards' => array_map(function ($h) {
          return [
            'type' => $h['type'] ?? 'explosion',
            'x' => (float) ($h['x'] ?? 0),
            'y' => (float) ($h['y'] ?? 0),
            'r' => (float) ($h['r'] ?? 60),
            'ttl' => isset($h['ttl']) ? (float) $h['ttl'] : 0,
            'dmg' => isset($h['dmg']) ? (float) $h['dmg'] : 10,
            // optional telegraph countdown for client-side conversion
            'tele' => isset($h['tele']) ? (float) $h['tele'] : null,
            'next' => isset($h['next']) ? $h['next'] : null,
          ];
        }, $state['hazards']),
        'items' => array_map(function ($it) {
          return [
            'id' => $it['id'],
            'type' => $it['type'] ?? 'heal',
            'x' => (float) ($it['x'] ?? 0),
            'y' => (float) ($it['y'] ?? 0),
            'r' => (float) ($it['r'] ?? 8),
            'value' => (float) ($it['value'] ?? 20),
            'elem' => isset($it['elem']) ? $it['elem'] : null,
          ];
        }, $state['items']),
      ];
      append_event($eventsDir, $roomId, $snapshot);
    }
  } catch (Throwable $e) {
    // ignore sim errors for resilience
  } finally {
    try {
      flock($lf, LOCK_UN);
      fclose($lf);
    } catch (Throwable $e) {
    }
  }
}
function safe_random_bytes($length)
{
  if (!is_int($length) || $length <= 0) {
    throw new InvalidArgumentException('Length must be a positive integer');
  }
  try {
    return random_bytes($length);
  } catch (Throwable $e) {
    $bytes = '';
    for ($i = 0; $i < $length; $i++) {
      try {
        $bytes .= chr(random_int(0, 255));
      } catch (Throwable $e2) {
        $bytes .= chr(mt_rand(0, 255));
      }
    }
    return $bytes;
  }
}
function json_out($obj)
{
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($obj, JSON_UNESCAPED_UNICODE);
}
function uid($len = 6)
{
  return substr(bin2hex(safe_random_bytes(8)), 0, $len);
}
function random_alnum_token($length = 12)
{
  if (!is_int($length) || $length <= 0)
    throw new InvalidArgumentException('Length must be a positive integer');
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  $alphabetLength = strlen($alphabet);
  if ($alphabetLength === 0)
    throw new RuntimeException('Alphabet must not be empty');
  $token = '';
  $maxByte = 256 - (256 % $alphabetLength);
  while (strlen($token) < $length) {
    $bytes = safe_random_bytes($length);
    $byteLen = strlen($bytes);
    for ($i = 0; $i < $byteLen && strlen($token) < $length; $i++) {
      $val = ord($bytes[$i]);
      if ($val >= $maxByte)
        continue;
      $token .= $alphabet[$val % $alphabetLength];
    }
  }
  return $token;
}
function rate_limit_snapshot($file, array $keys, int $windowSec, array $delayThresholds): array
{
  $status = ['delaySeconds' => 0.0, 'blockedUntil' => 0, 'failCount' => 0];
  if (empty($keys) || $windowSec <= 0)
    return $status;
  $now = time();
  $f = fopen($file, 'c+');
  if (!$f)
    return $status;
  if (!flock($f, LOCK_SH)) {
    fclose($f);
    return $status;
  }
  rewind($f);
  $raw = stream_get_contents($f);
  flock($f, LOCK_UN);
  fclose($f);
  $data = json_decode($raw ?: '{}', true);
  if (!is_array($data) || !isset($data['keys']) || !is_array($data['keys']))
    return $status;
  foreach ($keys as $key) {
    if (!isset($data['keys'][$key]) || !is_array($data['keys'][$key]))
      continue;
    $record = $data['keys'][$key];
    $fails = array_values(array_filter($record['fails'] ?? [], function ($ts) use ($now, $windowSec) {
      return is_numeric($ts) && ($now - (int) $ts) <= $windowSec;
    }));
    $count = count($fails);
    if ($count > $status['failCount'])
      $status['failCount'] = $count;
    $blockedUntil = isset($record['blockedUntil']) ? (int) $record['blockedUntil'] : 0;
    if ($blockedUntil > $status['blockedUntil'])
      $status['blockedUntil'] = $blockedUntil;
  }
  $delay = 0.0;
  foreach ($delayThresholds as $threshold => $seconds) {
    if ($status['failCount'] >= (int) $threshold && (float) $seconds > $delay)
      $delay = (float) $seconds;
  }
  $status['delaySeconds'] = $delay;
  return $status;
}
function rate_limit_update($file, array $keys, bool $success, int $windowSec, int $blockThreshold, int $blockDuration): void
{
  if (empty($keys) || $windowSec <= 0)
    return;
  $now = time();
  $f = fopen($file, 'c+');
  if (!$f)
    return;
  if (!flock($f, LOCK_EX)) {
    fclose($f);
    return;
  }
  rewind($f);
  $raw = stream_get_contents($f);
  $data = json_decode($raw ?: '{}', true);
  if (!is_array($data))
    $data = [];
  if (!isset($data['keys']) || !is_array($data['keys']))
    $data['keys'] = [];
  foreach ($keys as $key) {
    if (!isset($data['keys'][$key]) || !is_array($data['keys'][$key]))
      $data['keys'][$key] = ['fails' => [], 'blockedUntil' => 0];
    $record = $data['keys'][$key];
    $fails = array_values(array_filter($record['fails'] ?? [], function ($ts) use ($now, $windowSec) {
      return is_numeric($ts) && ($now - (int) $ts) <= $windowSec;
    }));
    if ($success) {
      $record = ['fails' => [], 'blockedUntil' => 0];
    } else {
      $fails[] = $now;
      $record['fails'] = $fails;
      $blockedUntil = isset($record['blockedUntil']) ? (int) $record['blockedUntil'] : 0;
      if ($blockThreshold > 0 && count($fails) >= $blockThreshold) {
        $record['blockedUntil'] = max($blockedUntil, $now + max(1, $blockDuration));
      } else {
        $record['blockedUntil'] = ($blockedUntil > $now) ? $blockedUntil : 0;
      }
    }
    $data['keys'][$key] = $record;
  }
  foreach ($data['keys'] as $key => $record) {
    if (!is_array($record)) {
      unset($data['keys'][$key]);
      continue;
    }
    $fails = array_values(array_filter($record['fails'] ?? [], function ($ts) use ($now, $windowSec) {
      return is_numeric($ts) && ($now - (int) $ts) <= $windowSec;
    }));
    $blockedUntil = isset($record['blockedUntil']) ? (int) $record['blockedUntil'] : 0;
    if (empty($fails) && $blockedUntil <= $now) {
      unset($data['keys'][$key]);
    } else {
      $data['keys'][$key] = ['fails' => $fails, 'blockedUntil' => $blockedUntil];
    }
  }
  rewind($f);
  ftruncate($f, 0);
  fwrite($f, json_encode($data, JSON_UNESCAPED_UNICODE));
  fflush($f);
  flock($f, LOCK_UN);
  fclose($f);
}

// Sanitize user provided strings to avoid XSS when echoed
function sanitize_text($text)
{
  return htmlspecialchars($text, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function truncate_utf8($text, $length, &$truncated = false)
{
  if (function_exists('mb_substr')) {
    $truncated = mb_strlen($text) > $length;
    return mb_substr($text, 0, $length);
  }
  $chars = preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY);
  if ($chars === false) {
    $truncated = strlen($text) > $length;
    return substr($text, 0, $length);
  }
  $truncated = count($chars) > $length;
  return implode('', array_slice($chars, 0, $length));
}

function decode_json_body($action)
{
  global $log;
  $raw = file_get_contents('php://input');
  $data = json_decode($raw, true);
  if (json_last_error() !== JSON_ERROR_NONE) {
    $short = truncate_utf8($raw, 100, $truncated);
    if ($truncated) $short .= '...';
    $log->warn($action . ':invalidJson', ['error' => json_last_error_msg(), 'input' => $short]);
    json_error('Invalid JSON', 400);
    return null;
  }
  if (is_array($data))
    vlg_enrich_exception_context_from_array($data);
  return $data ?? [];
}

function json_ok($extra = [])
{
  global $rid;
  if (!headers_sent() && !empty($rid))
    header('X-Request-ID: ' . $rid);
  if (!array_key_exists('rid', $extra))
    $extra['rid'] = $rid;
  json_out(array_merge(['ok' => true], $extra));
}
function json_error($message, $code = 400)
{
  http_response_code($code);
  global $rid;
  if (!headers_sent() && !empty($rid))
    header('X-Request-ID: ' . $rid);
  json_out(['ok' => false, 'error' => $message, 'rid' => $rid]);
}

function vlg_collect_exception_context(): array
{
  global $roomsFile, $stateDir;
  $context = vlg_get_exception_context();
  $roomId = isset($context['roomId']) && is_string($context['roomId']) ? trim($context['roomId']) : '';
  $userId = isset($context['userId']) && is_string($context['userId']) ? trim($context['userId']) : '';
  $derived = [];
  if ($roomId !== '' && $userId !== '') {
    $roomsRaw = @file_get_contents($roomsFile);
    if ($roomsRaw !== false) {
      $roomsData = json_decode($roomsRaw, true);
      if (json_last_error() === JSON_ERROR_NONE && isset($roomsData['rooms']) && is_array($roomsData['rooms'])) {
        foreach ($roomsData['rooms'] as $room) {
          if (!is_array($room) || ($room['id'] ?? '') !== $roomId)
            continue;
          if (!isset($derived['stage']) && isset($room['stage']) && is_string($room['stage'])) {
            $stage = trim($room['stage']);
            if ($stage !== '')
              $derived['stage'] = $stage;
          }
          if (isset($room['members']) && is_array($room['members'])) {
            foreach ($room['members'] as $member) {
              if (!is_array($member) || ($member['id'] ?? '') !== $userId)
                continue;
              if (!isset($derived['character']) && isset($member['character'])) {
                $character = $member['character'];
                if (is_string($character))
                  $derived['character'] = $character;
              }
              if (!isset($derived['alive'])) {
                if (array_key_exists('alive', $member)) {
                  $derived['alive'] = (bool) $member['alive'];
                } elseif (array_key_exists('dead', $member)) {
                  $derived['alive'] = !$member['dead'];
                }
              }
              foreach (['x', 'y'] as $coord) {
                if (!isset($derived[$coord]) && isset($member[$coord])) {
                  $value = $member[$coord];
                  if (is_int($value) || is_float($value))
                    $derived[$coord] = (float) $value;
                  elseif (is_string($value) && $value !== '' && is_numeric($value))
                    $derived[$coord] = (float) $value;
                }
              }
              break;
            }
          }
          break;
        }
      }
    }
    $needsState = (!isset($derived['x']) || !isset($derived['y']) || !isset($derived['alive']) || !isset($derived['character']) || !isset($derived['stage']));
    if ($needsState) {
      $stateFile = rtrim($stateDir, '/\\') . '/' . $roomId . '.json';
      $stateRaw = @file_get_contents($stateFile);
      if ($stateRaw !== false) {
        $stateData = json_decode($stateRaw, true);
        if (json_last_error() === JSON_ERROR_NONE && isset($stateData['players']) && is_array($stateData['players'])) {
          $playerState = $stateData['players'][$userId] ?? null;
          if (is_array($playerState)) {
            foreach (['x', 'y'] as $coord) {
              if (!isset($derived[$coord]) && isset($playerState[$coord])) {
                $value = $playerState[$coord];
                if (is_int($value) || is_float($value))
                  $derived[$coord] = (float) $value;
                elseif (is_string($value) && $value !== '' && is_numeric($value))
                  $derived[$coord] = (float) $value;
              }
            }
            if (!isset($derived['alive']) && array_key_exists('alive', $playerState))
              $derived['alive'] = (bool) $playerState['alive'];
            if (!isset($derived['character']) && isset($playerState['character']) && is_string($playerState['character']))
              $derived['character'] = $playerState['character'];
          }
          if (!isset($derived['stage']) && isset($stateData['stage']) && is_string($stateData['stage'])) {
            $stage = trim($stateData['stage']);
            if ($stage !== '')
              $derived['stage'] = $stage;
          }
        }
      }
    }
  }
  foreach ($derived as $key => $value) {
    if (!array_key_exists($key, $context) || $context[$key] === null || $context[$key] === '')
      $context[$key] = $value;
  }
  return $context;
}

function vlg_log_uncaught_exception(\Throwable $e): void
{
  global $log;
  $context = vlg_collect_exception_context();
  foreach (['userId', 'roomId', 'x', 'y', 'character', 'alive', 'stage'] as $key) {
    if (!array_key_exists($key, $context))
      $context[$key] = null;
  }
  $log->exception($e, $context);
  json_error('サーバー内部エラー: ' . $e->getMessage(), 500);
}
function find_member_index(&$room, $playerId)
{
  foreach ($room['members'] as $idx => $m) {
    if (($m['id'] ?? '') === $playerId)
      return $idx;
  }
  return null;
}

function authenticate_room_member(array &$room, string $playerId, string $authToken): array
{
  //パスワード未設定の部屋は認証しない
  if ($playerId === '' || $authToken === '')
    return ['ok' => false, 'reason' => 'auth'];
  foreach ($room['members'] as $idx => $m) {
    if (($m['id'] ?? '') !== $playerId)
      continue;
    $stored = $m['authToken'] ?? '';
    if ($stored === '' || !hash_equals($stored, $authToken))
      return ['ok' => false, 'reason' => 'auth'];
    return ['ok' => true, 'index' => $idx];
  }
  return ['ok' => false, 'reason' => 'notFound'];
}

function touch_member(&$room, $playerId)
{
  $idx = find_member_index($room, $playerId);
  if ($idx !== null) {
    $now = microtime(true);
    $room['members'][$idx]['lastSeen'] = $now;
    $roomId = $room['id'] ?? null;
    if ($roomId !== null) {
      global $stateDir;
      if (!empty($stateDir)) {
        try {
          update_player_snapshot($stateDir, $roomId, $playerId, ['lastSeen' => $now]);
        } catch (Throwable $e) {
        }
      }
    }
    return true;
  }
  return false;
}

function cleanup_orphan_room_logs($eventsDir, array $rooms, int $graceSeconds = 5): void
{
  if (!is_dir($eventsDir))
    return;
  $active = [];
  foreach ($rooms as $room) {
    $id = isset($room['id']) ? (string) $room['id'] : '';
    if ($id !== '')
      $active[$id] = true;
  }
  $pattern = rtrim($eventsDir, '/\\') . '/*.log';
  $files = glob($pattern);
  if ($files === false)
    return;
  $now = time();
  foreach ($files as $file) {
    if (!is_file($file))
      continue;
    $base = basename($file, '.log');
    if ($base === '' || isset($active[$base]))
      continue;
    $mtime = @filemtime($file);
    if ($mtime !== false && ($now - $mtime) <= $graceSeconds)
      continue;
    @unlink($file);
  }
}

function cleanup_rooms(&$data, $eventsDir, $stateDir, $ttlHours, $memberTtlSec = 60)
{
  global $PAUSE_TTL_SEC;
  $now = microtime(true);
  $changed = false;
  $removed = [];
  foreach ($data['rooms'] as $ri => &$room) {
    ensure_room_flags($room);
    if (ensure_room_security($room))
      $changed = true;
    // メンバーのstale除去
    $members = $room['members'] ?? [];
    $beforeCount = count($members);
    $stateSnapshot = null;
    $statePlayers = [];
    $syncedMembers = false;
    if (!empty($stateDir) && isset($room['id'])) {
      $loadedState = read_state($stateDir, $room['id']);
      if (is_array($loadedState)) {
        $stateSnapshot = ensure_state_shape($loadedState);
      } elseif (!empty($members)) {
        $stateSnapshot = default_room_state();
      }
      if (is_array($stateSnapshot) && isset($stateSnapshot['players']) && is_array($stateSnapshot['players']))
        $statePlayers = $stateSnapshot['players'];
    }
    if (!empty($statePlayers)) {
      foreach ($members as &$member) {
        $pid = (string) ($member['id'] ?? '');
        if ($pid === '' || !isset($statePlayers[$pid]) || !is_array($statePlayers[$pid]))
          continue;
        $snap = $statePlayers[$pid];
        if (isset($snap['lastSeen'])) {
          $stateSeen = (float) $snap['lastSeen'];
          if ($stateSeen > (float) ($member['lastSeen'] ?? 0)) {
            $member['lastSeen'] = $stateSeen;
            $syncedMembers = true;
          }
        }
        if (!isset($member['alive']) && isset($snap['alive'])) {
          $member['alive'] = (bool) $snap['alive'];
          $syncedMembers = true;
        }
      }
      unset($member);
    }
    $members = array_values(array_filter($members, function ($m) use ($now, $memberTtlSec) {
      $seen = (float) ($m['lastSeen'] ?? 0);
      // lastSeenが無い古いデータは厳しめに切る
      if ($seen <= 0)
        return false;
      return ($now - $seen) <= $memberTtlSec;
    }));
    if ($beforeCount !== count($members)) {
      $changed = true;
      $room['members'] = $members;
      // オーナーが抜けていたら先頭を新オーナーに
      if (!empty($members)) {
        if (!in_array($room['owner'] ?? '', array_map(fn($m) => $m['id'] ?? '', $members), true)) {
          $room['owner'] = $members[0]['id'];
        }
      }
    } elseif ($syncedMembers) {
      $room['members'] = $members;
      $room['updatedAt'] = time();
      $changed = true;
    }
    if (is_array($stateSnapshot)) {
      $stateTouched = false;
      foreach ($members as $member) {
        $pid = (string) ($member['id'] ?? '');
        if ($pid === '')
          continue;
        $hadExisting = isset($statePlayers[$pid]) && is_array($statePlayers[$pid]);
        $existing = $hadExisting ? $statePlayers[$pid] : ['id' => $pid];
        $entry = $existing;
        if (!isset($entry['id']) || $entry['id'] !== $pid) {
          $entry['id'] = $pid;
          $stateTouched = true;
        }
        if (array_key_exists('alive', $member)) {
          $aliveFlag = (bool) $member['alive'];
          if (!array_key_exists('alive', $entry) || (bool) $entry['alive'] !== $aliveFlag) {
            $entry['alive'] = $aliveFlag;
            $stateTouched = true;
          }
        }
        if (isset($member['lastSeen'])) {
          $memberSeen = (float) $member['lastSeen'];
          $prevSeen = isset($entry['lastSeen']) ? (float) $entry['lastSeen'] : 0.0;
          if ($memberSeen > $prevSeen + 1e-6) {
            $entry['lastSeen'] = $memberSeen;
            $stateTouched = true;
          }
        }
        foreach (['x', 'y'] as $coordKey) {
          if (isset($member[$coordKey])) {
            $value = (float) $member[$coordKey];
            $prevValue = isset($entry[$coordKey]) ? (float) $entry[$coordKey] : null;
            if ($prevValue === null || abs($prevValue - $value) > 1e-6) {
              $entry[$coordKey] = $value;
              $stateTouched = true;
            }
          }
        }
        foreach (['hp', 'maxHp', 'armor', 'maxArmor', 'ts'] as $key) {
          if (!isset($member[$key]))
            continue;
          $val = $member[$key];
          if (!array_key_exists($key, $entry)) {
            $entry[$key] = $val;
            $stateTouched = true;
            continue;
          }
          $prevVal = $entry[$key];
          if (is_numeric($prevVal) && is_numeric($val)) {
            if (abs((float) $prevVal - (float) $val) > 1e-6) {
              $entry[$key] = $val;
              $stateTouched = true;
            }
          } elseif ($prevVal !== $val) {
            $entry[$key] = $val;
            $stateTouched = true;
          }
        }
        foreach (['name', 'elem'] as $key) {
          if (!isset($member[$key]))
            continue;
          $val = $member[$key];
          if (!array_key_exists($key, $entry) || $entry[$key] !== $val) {
            $entry[$key] = $val;
            $stateTouched = true;
          }
        }
        if (!$hadExisting || $entry !== $existing) {
          $statePlayers[$pid] = $entry;
          $stateTouched = true;
        }
      }
      if ($stateTouched) {
        $stateSnapshot['players'] = $statePlayers;
        write_state($stateDir, $room['id'], $stateSnapshot);
      }
    }
    $roomId = isset($room['id']) ? (string) $room['id'] : '';
    if (cleanup_room_pause_flags($room, $roomId, $eventsDir, $PAUSE_TTL_SEC)) {
      $changed = true;
    }
  }
  unset($room);
  // 空部屋やTTL超過の部屋を削除
  $beforeRooms = count($data['rooms'] ?? []);
  $newRooms = [];
  foreach ($data['rooms'] ?? [] as $room) {
    $updatedAt = $room['updatedAt'] ?? 0;
    if (empty($room['members']) || ($updatedAt > 0 && ($now - $updatedAt) > ($ttlHours * 3600))) {
      $removed[] = $room['id'] ?? null;
      continue;
    }
    $newRooms[] = $room;
  }
  if ($beforeRooms !== count($newRooms)) {
    $changed = true;
    $data['rooms'] = $newRooms;
  }
  foreach ($removed as $rid) {
    if ($rid === null) continue;
    @unlink("$eventsDir/$rid.log");
    @unlink("$stateDir/$rid.json");
    @unlink("$stateDir/sim_$rid.lock");
  }
  cleanup_orphan_room_logs($eventsDir, $data['rooms'] ?? []);
  return $changed;
}

try {
  switch ($action) {
    case 'listGallery':
      $galleryRoot = realpath(__DIR__ . '/gallery');
      $files = [];
      if ($galleryRoot && is_dir($galleryRoot)) {
        try {
          $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($galleryRoot, FilesystemIterator::SKIP_DOTS)
          );
          foreach ($iterator as $fileInfo) {
            if (!$fileInfo->isFile())
              continue;
            $ext = strtolower($fileInfo->getExtension());
            if (!in_array($ext, ['png', 'jpg', 'jpeg', 'gif', 'webp'], true))
              continue;
            $path = $fileInfo->getPathname();
            if (strpos($path, $galleryRoot) !== 0)
              continue;
            $relative = substr($path, strlen($galleryRoot) + 1);
            if ($relative === false || $relative === '')
              continue;
            $relative = str_replace('\\', '/', $relative);
            $files[] = $relative;
          }
        } catch (UnexpectedValueException $e) {
          $log->warn('listGallery:iterateFailed', ['error' => $e->getMessage()]);
        }
      }
      sort($files, SORT_NATURAL | SORT_FLAG_CASE);
      $images = [];
      foreach ($files as $index => $file) {
        $segments = preg_split('/[\\\\\/]+/', $file, -1, PREG_SPLIT_NO_EMPTY);
        if (!$segments)
          continue;
        $encoded = implode('/', array_map('rawurlencode', $segments));
        $images[] = [
          'id' => 'gallery_' . ($index + 1),
          'filename' => $file,
          'title' => $file,
          'url' => 'gallery/' . $encoded,
          'thumbnail' => 'gallery/' . $encoded,
        ];
      }
      $log->debug('listGallery', ['count' => count($images)]);
      json_ok(['images' => $images]);
      break;

    case 'listRooms':
      $data = read_json($roomsFile);
      $changed = cleanup_rooms($data, $eventsDir, $stateDir, $ROOM_TTL_HOURS);
      if ($changed)
        write_json($roomsFile, $data);
      $log->debug('listRooms', ['count' => count($data['rooms'])]);
      foreach ($data['rooms'] as &$room) {
        $room = room_public_payload($room);
      }
      unset($room);
      json_ok(['rooms' => $data['rooms'], 'rid' => $rid]);
      break;

    case 'resourceStats':
      $stats = get_resource_stats();
      json_ok(['stats' => $stats]);
      break;

    case 'createRoom':
      $input = decode_json_body('createRoom');
      if ($input === null)
        break;
      $name = $input['playerName'] ?? ('P' . rand(100, 999));
      if (!is_string($name)) {
        $log->warn('createRoom:invalidPlayerNameType', ['type' => gettype($name)]);
        json_error('無効なプレイヤー名です', 400);
        break;
      }
      $passwordProtected = !empty($input['passwordProtected']);
      $truncated = false;
      $name = truncate_utf8($name, 10, $truncated);
      $name = sanitize_text($name);
      $data = read_json($roomsFile);
      $changed = cleanup_rooms($data, $eventsDir, $stateDir, $ROOM_TTL_HOURS);
      if ($changed)
        write_json($roomsFile, $data);
      if (count($data['rooms']) >= $MAX_ROOMS) {
        $log->warn('createRoom:roomLimit', ['limit' => $MAX_ROOMS]);
        json_out(['ok' => false, 'error' => '部屋数が上限に達しています']);
        break;
      }
      $roomId = strtoupper(uid(6));
      $playerId = uid(12);
      $publicId = strtoupper(uid(10));
      $authToken = bin2hex(safe_random_bytes(32));
      $room = [
        'id' => $roomId,
        'members' => [[
          'id' => $playerId,
          'publicId' => $publicId,
          'authToken' => $authToken,
          'name' => $name,
          'character' => null,
          'ready' => false,
          'lastSeen' => microtime(true),
        ]],
        'stage' => null,
        'difficulty' => 'ふつう',
        'owner' => $playerId,
        'status' => 'room', // room|game|result
        'updatedAt' => time(),
        'flags' => [],
      ];
      if ($passwordProtected) {
        $room['password'] = random_alnum_token(12);
      }
      $data['rooms'][] = $room;
      write_json($roomsFile, $data);
      touch("$eventsDir/$roomId.log");
      $log->info('createRoom', ['roomId' => $roomId, 'owner' => $playerId]);
      json_ok([
        'room' => room_public_payload($room),
        'playerId' => $playerId,
        'publicId' => $publicId,
        'authToken' => $authToken,
        'password' => $room['password'] ?? null,
        'rid' => $rid,
      ]);
      break;

    case 'joinRoom':
      $input = decode_json_body('joinRoom');
      if ($input === null)
        break;
      $roomId = $input['roomId'] ?? '';
      $name = $input['playerName'] ?? ('P' . rand(100, 999));
      if (!is_string($name)) {
        $log->warn('joinRoom:invalidPlayerNameType', ['type' => gettype($name)]);
        json_error('無効なプレイヤー名です', 400);
        break;
      }
      $password = $input['password'] ?? '';
      $truncated = false;
      $name = truncate_utf8($name, 10, $truncated);
      $name = sanitize_text($name);
      $data = read_json($roomsFile);
      $playerIdHint = isset($input['playerId']) ? trim((string) $input['playerId']) : '';
      if ($playerIdHint !== '')
        $playerIdHint = substr(preg_replace('/[^A-Za-z0-9_-]/', '', $playerIdHint), 0, 64);
      $remoteIp = $_SERVER['REMOTE_ADDR'] ?? '';
      $rateKeys = [];
      if ($playerIdHint !== '')
        $rateKeys[] = 'player:' . $playerIdHint;
      if ($remoteIp !== '')
        $rateKeys[] = 'ip:' . $remoteIp;
      if (empty($rateKeys))
        $rateKeys[] = 'ip:unknown';
      $rateStatus = rate_limit_snapshot($joinAttemptsFile, $rateKeys, $JOIN_RATE_WINDOW_SEC, $JOIN_RATE_DELAY_THRESHOLDS);
      $now = time();
      if ($rateStatus['blockedUntil'] > $now) {
        $wait = max(1, $rateStatus['blockedUntil'] - $now);
        json_out(['ok' => false, 'error' => '試行が多すぎます。' . $wait . '秒後に再試行してください']);
        return;
      }
      if ($rateStatus['delaySeconds'] > 0) {
        usleep((int) round($rateStatus['delaySeconds'] * 1000000));
      }
      foreach ($data['rooms'] as &$room) {
        ensure_room_flags($room);
        if ($room['id'] === $roomId) {
          if (isset($room['password']) && $room['password'] !== $password) {
            rate_limit_update($joinAttemptsFile, $rateKeys, false, $JOIN_RATE_WINDOW_SEC, $JOIN_RATE_BLOCK_THRESHOLD, $JOIN_RATE_BLOCK_DURATION);
            json_out(['ok' => false, 'error' => 'パスワードが違います（英数字12桁です）']);
            return;
          }
          if (count($room['members']) >= 5) {
            json_out(['ok' => false, 'error' => '満員']);
            return;
          }
          if (($room['status'] ?? 'room') !== 'room') {
            json_out(['ok' => false, 'error' => ($room['status'] === 'result') ? 'リザルト中' : '進行中']);
            return;
          }
          $playerId = uid(12);
          $publicId = strtoupper(uid(10));
          $authToken = bin2hex(safe_random_bytes(32));
          $room['members'][] = [
            'id' => $playerId,
            'publicId' => $publicId,
            'authToken' => $authToken,
            'name' => $name,
            'character' => null,
            'ready' => false,
            'lastSeen' => microtime(true),
          ];
          $room['updatedAt'] = time();
          write_json($roomsFile, $data);
          append_event($eventsDir, $roomId, ['type' => 'roomUpdate', 'room' => room_public_payload($room)]);
          $log->info('joinRoom', ['roomId' => $roomId, 'playerId' => $playerId]);
          $passwordForClient = (($room['owner'] ?? '') === $playerId) ? ($room['password'] ?? null) : null;
          rate_limit_update($joinAttemptsFile, $rateKeys, true, $JOIN_RATE_WINDOW_SEC, $JOIN_RATE_BLOCK_THRESHOLD, $JOIN_RATE_BLOCK_DURATION);
          json_ok([
            'room' => room_public_payload($room),
            'playerId' => $playerId,
            'publicId' => $publicId,
            'authToken' => $authToken,
            'password' => $passwordForClient,
            'rid' => $rid,
          ]);
          return;
        }
      }
      unset($room);
      $log->warn('joinRoom:notFound', ['roomId' => $roomId]);
      json_error('部屋が見つかりません', 404);
      break;

    case 'leaveRoom':
      $input = decode_json_body('leaveRoom');
      if ($input === null)
        break;
      $roomId = $input['roomId'] ?? '';
      $playerId = $input['playerId'] ?? '';
      $authToken = $input['authToken'] ?? '';
      $data = read_json($roomsFile);
      foreach ($data['rooms'] as $i => &$room) {
        if ($room['id'] === $roomId) {
          ensure_room_security($room);
          $auth = authenticate_room_member($room, $playerId, $authToken);
          if (!$auth['ok']) {
            if ($auth['reason'] === 'notFound') {
              json_error('プレイヤーが見つかりません', 404);
            } else {
              json_error('認証に失敗しました', 401);
            }
            return;
          }
          // remove target member explicitly (avoid closure var capture issues)
          $newMembers = [];
          foreach ($room['members'] as $m) {
            if (($m['id'] ?? '') !== $playerId)
              $newMembers[] = $m;
          }
          $room['members'] = $newMembers;
          if (empty($room['members'])) { // delete room
            array_splice($data['rooms'], $i, 1);
            $path = "$eventsDir/$roomId.log";
            if (is_file($path) && !unlink($path)) {
              $log->warn('leaveRoom:unlinkFailed', ['file' => $path]);
            }
          } else {
            if ($room['owner'] === $playerId)
              $room['owner'] = $room['members'][0]['id'];
            $room['updatedAt'] = time();
            append_event($eventsDir, $roomId, ['type' => 'roomUpdate', 'room' => room_public_payload($room)]);
          }
          write_json($roomsFile, $data);
          $log->info('leaveRoom', ['roomId' => $roomId, 'playerId' => $playerId]);
          json_ok(['rid' => $rid]);
          return;
        }
      }
      unset($room);
      $log->warn('leaveRoom:notFound', ['roomId' => $roomId]);
      json_error('部屋が見つかりません', 404);
      break;

    case 'setLoadout':
      $input = decode_json_body('setLoadout');
      if ($input === null)
        break;
      $roomId = $input['roomId'] ?? '';
      $playerId = $input['playerId'] ?? '';
      $authToken = $input['authToken'] ?? '';
      $character = $input['character'] ?? null;
      $stage = $input['stage'] ?? null;
      $difficulty = $input['difficulty'] ?? null;
      $hasIgnition = array_key_exists('ignitionMode', $input);
      $ignitionMode = $hasIgnition ? (bool) $input['ignitionMode'] : false;
      $data = read_json($roomsFile);
      foreach ($data['rooms'] as &$room) {
        ensure_room_flags($room);
        ensure_room_security($room);
        if ($room['id'] === $roomId) {
          // ゲーム中・結果画面、または自分が準備中は変更不可
          if (($room['status'] ?? 'room') !== 'room') {
            json_error('ゲーム中または結果画面では変更できません', 409);
            return;
          }
          $auth = authenticate_room_member($room, $playerId, $authToken);
          if (!$auth['ok']) {
            if ($auth['reason'] === 'notFound') {
              json_error('プレイヤーが見つかりません', 404);
            } else {
              json_error('認証に失敗しました', 401);
            }
            return;
          }
          $targetIndex = $auth['index'];
          if (!!($room['members'][$targetIndex]['ready'] ?? false)) {
            json_error('準備中は変更できません', 409);
            return;
          }
          // 変更を適用（キャラは本人、ステージ/難易度は部屋主のみ）
          $room['members'][$targetIndex]['character'] = $character;
          $room['members'][$targetIndex]['lastSeen'] = microtime(true);
          if ($stage !== null) {
            if (($room['owner'] ?? '') === $playerId) {
              // オーナーのみステージ変更を反映
              $room['stage'] = $stage;
            } else {
              $stage = null;
            }
          }
          if ($difficulty !== null) {
            if (($room['owner'] ?? '') === $playerId) {
              $room['difficulty'] = $difficulty;
            } else {
              $difficulty = null;
            }
          }
          if ($hasIgnition) {
            if (($room['owner'] ?? '') === $playerId) {
              if ($ignitionMode) {
                $room['flags']['ignitionMode'] = true;
              } else {
                unset($room['flags']['ignitionMode']);
              }
            } else {
              $hasIgnition = false;
            }
          }
          if (($room['difficulty'] ?? null) !== 'むずかしい') {
            unset($room['flags']['ignitionMode']);
          }
          $room['updatedAt'] = time();
          write_json($roomsFile, $data);
          append_event($eventsDir, $roomId, ['type' => 'roomUpdate', 'room' => room_public_payload($room)]);
          $log->debug('setLoadout', ['roomId' => $roomId, 'playerId' => $playerId, 'character' => $character, 'stage' => $stage, 'difficulty' => $difficulty, 'ignitionMode' => $hasIgnition ? $ignitionMode : null]);
          json_ok(['rid' => $rid]);
          return;
        }
      }
      unset($room);
      $log->warn('setLoadout:notFound', ['roomId' => $roomId]);
      json_error('部屋が見つかりません', 404);
      break;

    case 'setReady':
      $input = decode_json_body('setReady');
      if ($input === null)
        break;
      $roomId = $input['roomId'] ?? '';
      $playerId = $input['playerId'] ?? '';
      $authToken = $input['authToken'] ?? '';
      $ready = (bool) ($input['ready'] ?? false);
      $data = read_json($roomsFile);
      foreach ($data['rooms'] as &$room) {
        if ($room['id'] === $roomId) {
          ensure_room_security($room);
          $auth = authenticate_room_member($room, $playerId, $authToken);
          if (!$auth['ok']) {
            if ($auth['reason'] === 'notFound') {
              json_error('プレイヤーが見つかりません', 404);
            } else {
              json_error('認証に失敗しました', 401);
            }
            return;
          }
          $idx = $auth['index'];
          $room['members'][$idx]['ready'] = $ready;
          $room['members'][$idx]['lastSeen'] = microtime(true);
          $room['updatedAt'] = time();
          write_json($roomsFile, $data);
          append_event($eventsDir, $roomId, ['type' => 'roomUpdate', 'room' => room_public_payload($room)]);
          $log->debug('setReady', ['roomId' => $roomId, 'playerId' => $playerId, 'ready' => $ready]);
          json_ok(['rid' => $rid]);
          return;
        }
      }
      unset($room);
      $log->warn('setReady:notFound', ['roomId' => $roomId]);
      json_error('部屋が見つかりません', 404);
      break;

    case 'startGame':
      $input = decode_json_body('startGame');
      if ($input === null)
        break;
      $roomId = $input['roomId'] ?? '';
      $playerId = $input['playerId'] ?? '';
      $authToken = $input['authToken'] ?? '';
      $data = read_json($roomsFile);
      foreach ($data['rooms'] as &$room) {
        if ($room['id'] === $roomId) {
          ensure_room_security($room);
          $auth = authenticate_room_member($room, $playerId, $authToken);
          if (!$auth['ok']) {
            if ($auth['reason'] === 'notFound') {
              json_error('プレイヤーが見つかりません', 404);
            } else {
              json_error('認証に失敗しました', 401);
            }
            return;
          }
          // オーナーのみ開始可能
          if (($room['owner'] ?? '') !== $playerId) {
            $log->warn('startGame:forbidden', ['roomId' => $roomId, 'by' => $playerId, 'owner' => $room['owner'] ?? '']);
            json_error('開始できるのは部屋主のみです', 403);
            return;
          }
          // 全員Readyでない場合は開始不可
          $allReady = true;
          foreach ($room['members'] as $m) {
            if (!($m['ready'] ?? false)) {
              $allReady = false;
              break;
            }
          }
          if (!$allReady) {
            $log->warn('startGame:notAllReady', ['roomId' => $roomId]);
            json_error('全員準備完了ではありません', 409);
            return;
          }
          $room['status'] = 'game';
          // record server-side game start time (epoch seconds) after 3s countdown
          $room['gameStartAt'] = time() + 3;
          // enable simple server-side enemy simulation
          $room['simEnemies'] = true;
          // clear any lingering pause flags
          $room['pauseBy'] = [];
          unset($room['pauseTimes']);
          // reset per-player server kill counters
          foreach ($room['members'] as &$m0) {
            unset($m0['dead']);
            unset($m0['svKills']);
            unset($m0['lastKills']);
            unset($m0['lastDuration']);
            unset($m0['reviveUsed']);
            $m0['elem'] = null;
            $m0['exp'] = 0;
            $m0['lvl'] = 1;
            $m0['nextExp'] = 10;
          }
          unset($m0);
          touch_member($room, $playerId);
          $room['updatedAt'] = time();
          write_json($roomsFile, $data);
          // clear previous sim state file if exists
          $path = $stateDir . '/' . $roomId . '.json';
          if (is_file($path) && !unlink($path)) {
            $log->warn('startGame:unlinkFailed', ['file' => $path]);
          }
          // broadcast start with server start time for clients to anchor their timers
          append_event($eventsDir, $roomId, [
            'type' => 'gameStart',
            'gameStartAt' => $room['gameStartAt'],
            // server wall-clock (ms) at emit time
            'svt' => (int) round(microtime(true) * 1000),
            // inform clients that the server will drive enemy simulation
            'sim' => 'server',
          ]);
          $log->info('startGame', ['roomId' => $roomId]);
          json_ok(['rid' => $rid]);
          return;
        }
      }
      unset($room);
      $log->warn('startGame:notFound', ['roomId' => $roomId]);
      json_error('部屋が見つかりません', 404);
      break;

    case 'postEvent':
      $input = decode_json_body('postEvent');
      if ($input === null)
        break;
      $roomId = $input['roomId'] ?? '';
      $playerId = $input['playerId'] ?? '';
      $authToken = $input['authToken'] ?? '';
      if (!is_string($authToken) || $authToken === '') {
        json_error('認証に失敗しました', 401);
        break;
      }
      $event = $input['event'] ?? [];
      $authData = read_json($roomsFile);
      $roomIndex = null;
      $playerPublicId = null;
      $authRoom = null;
      $authMemberIndex = null;
      $securityChanged = false;
      foreach ($authData['rooms'] as $idx => &$room) {
        if (($room['id'] ?? '') !== $roomId)
          continue;
        $securityChanged = ensure_room_security($room) || $securityChanged;
        $auth = authenticate_room_member($room, $playerId, $authToken);
        if (!$auth['ok']) {
          if ($auth['reason'] === 'notFound') {
            json_error('プレイヤーが見つかりません', 404);
          } else {
            json_error('認証に失敗しました', 401);
          }
          return;
        }
        $roomIndex = $idx;
        $authMemberIndex = $auth['index'] ?? null;
        if ($authMemberIndex !== null)
          $playerPublicId = $room['members'][$authMemberIndex]['publicId'] ?? null;
        $authRoom = $room;
        break;
      }
      unset($room);
      if ($roomIndex === null) {
        json_error('部屋が見つかりません', 404);
        break;
      }
      $authRoom = &$authData['rooms'][$roomIndex];
      if ($securityChanged) {
        write_json($roomsFile, $authData);
      }
      if ($playerPublicId === null && $authRoom !== null) {
        $playerPublicId = get_member_public_id($authRoom, $playerId) ?? $playerId;
      }
      if (($event['type'] ?? '') === 'finish') {
        // Legacy endpoint: broadcast simple group end notice (not personal)
        $dur = (int) ($event['duration'] ?? 0);
        $kills = (int) ($event['kills'] ?? 0);
        // return room to room state and notify via roomUpdate so clients refresh flags
        $data = read_json($roomsFile);
        $updatedRoomCopy = null;
        foreach ($data['rooms'] as &$room) {
          if ($room['id'] === $roomId) {
            $room['status'] = 'room';
            $room['updatedAt'] = time();
            touch_member($room, $playerId);
            unset($room['pauseBy']);
            unset($room['pauseTimes']);
            unset($room['simEnemies']);
            foreach ($room['members'] as &$m) {
              $m['ready'] = false;
              unset($m['dead']);
              unset($m['lastKills']);
              unset($m['lastDuration']);
              unset($m['svKills']);
              unset($m['reviveUsed']);
              $m['exp'] = 0;
              $m['lvl'] = 1;
              $m['nextExp'] = 10;
            }
            unset($m);
            // copy after mutation for SSE payload
            $updatedRoomCopy = $room;
            break;
          }
        }
        write_json($roomsFile, $data);
        unset($room);
        // clear sim state file
        $path = $stateDir . '/' . $roomId . '.json';
        if (is_file($path) && !unlink($path)) {
          $log->warn('finish:unlinkFailed', ['file' => $path]);
        }
        clear_event_log($eventsDir, $roomId);
        append_event($eventsDir, $roomId, ['type' => 'result', 'duration' => $dur, 'kills' => $kills]);
        if ($updatedRoomCopy !== null) {
          append_event($eventsDir, $roomId, ['type' => 'roomUpdate', 'room' => room_public_payload($updatedRoomCopy)]);
        }
        $log->info('finish', ['roomId' => $roomId, 'duration' => $dur, 'kills' => $kills]);
      } elseif (($event['type'] ?? '') === 'death') {
        // mark player as dead; immediately send a personal result event to stream
        $data = read_json($roomsFile);
        foreach ($data['rooms'] as &$room) {
          if ($room['id'] !== $roomId)
            continue;
          $myKills = null;
          $myDur = null;
          foreach ($room['members'] as &$m) {
            if ($m['id'] === $playerId) {
              $m['dead'] = true;
              $m['lastSeen'] = microtime(true);
              // クライアントから渡された暫定スコアを保持
              // Prefer server-tracked kills if present
              if (isset($m['svKills'])) {
                $m['lastKills'] = (int) $m['svKills'];
              } elseif (isset($event['kills'])) {
                $m['lastKills'] = (int) $event['kills'];
              }
              // durationはサーバーのgameStartAtから算出（サーバー権威）
              $serverDur = null;
              if (isset($room['gameStartAt']) && is_int($room['gameStartAt'])) {
                $serverDur = max(0, (int) (time() - $room['gameStartAt']));
              }
              if ($serverDur === null && isset($event['duration'])) {
                // フォールバック: 古いクライアント向け
                $serverDur = (int) $event['duration'];
              }
              $m['lastDuration'] = $serverDur ?? 0;
              $myKills = (int) ($m['lastKills'] ?? 0);
              $myDur = (int) ($m['lastDuration'] ?? 0);
            }
          }
          unset($m); // break reference to last member
          $room['updatedAt'] = time();
          write_json($roomsFile, $data);
          // personalResult: only for the player who died
          if ($myKills === null)
            $myKills = (int) ($event['kills'] ?? 0);
          if ($myDur === null) {
            $myDur = isset($room['gameStartAt']) ? max(0, (int) (time() - $room['gameStartAt'])) : (int) ($event['duration'] ?? 0);
          }
          append_event($eventsDir, $roomId, ['type' => 'personalResult', 'playerId' => $playerPublicId, 'duration' => $myDur, 'kills' => $myKills]);
          // if everyone dead, broadcast result and reset room
          $allDead = true;
          foreach ($room['members'] as $m) {
            if (empty($m['dead'])) {
              $allDead = false;
              break;
            }
          }
          if ($allDead) {
            // 全体終了通知（集計）。個人表示は各自 personalResult 済み。
            $sumKills = 0;
            $maxDuration = 0;
            foreach ($room['members'] as $m) {
              $sumKills += (int) ($m['lastKills'] ?? 0);
              $maxDuration = max($maxDuration, (int) ($m['lastDuration'] ?? 0));
            }
            // reset room
            foreach ($room['members'] as &$m) {
              $m['ready'] = false;
              unset($m['dead']);
              unset($m['lastKills']);
              unset($m['lastDuration']);
              unset($m['svKills']);
              unset($m['reviveUsed']);
              $m['exp'] = 0;
              $m['lvl'] = 1;
              $m['nextExp'] = 10;
            }
            unset($m); // clear reference from previous loop
            $room['status'] = 'room';
            unset($room['gameStartAt']);
            unset($room['pauseBy']);
            unset($room['simEnemies']);
            write_json($roomsFile, $data);
            clear_event_log($eventsDir, $roomId);
            // also push a roomUpdate so clients drop stale Ready flags
            append_event($eventsDir, $roomId, ['type' => 'result', 'duration' => $maxDuration, 'kills' => $sumKills]);
            append_event($eventsDir, $roomId, ['type' => 'roomUpdate', 'room' => room_public_payload($room)]);
            // clear sim state file
            $path = $stateDir . '/' . $roomId . '.json';
            if (is_file($path) && !unlink($path)) {
              $log->warn('death:unlinkFailed', ['file' => $path]);
            }
          }
          // notify others who died
          append_event($eventsDir, $roomId, ['type' => 'allyDead', 'playerId' => $playerPublicId]);
          break;
        }
        $log->info('death', ['roomId' => $roomId, 'playerId' => $playerId]);
        unset($room);
      } elseif (($event['type'] ?? '') === 'riskRewardCountdown') {
        if (($authRoom['owner'] ?? '') !== $playerId) {
          json_error('この操作はホストのみ可能です', 403);
          break;
        }
        $eventIndexReq = null;
        if (isset($event['eventIndex']) && is_numeric($event['eventIndex']))
          $eventIndexReq = (int) $event['eventIndex'];
        $durationReq = isset($event['duration']) ? (float) $event['duration'] : $RISK_EVENT_DURATION;
        if (!is_finite($durationReq) || $durationReq <= 0)
          $durationReq = $RISK_EVENT_DURATION;
        $lockFile = $stateDir . '/sim_' . $roomId . '.lock';
        $lf2 = fopen($lockFile, 'c+');
        if (!$lf2) {
          json_error('現在この操作は行えません', 409);
          break;
        }
        if (!flock($lf2, LOCK_EX)) {
          fclose($lf2);
          json_error('現在この操作は行えません', 409);
          break;
        }
        $areasOut = [];
        $eventIndexOut = 0;
        $changed = false;
        try {
          $stateData = read_state($stateDir, $roomId);
          $stateData = ensure_state_shape($stateData);
          $eventIndexOut = (int) ($stateData['riskEventIndex'] ?? 0);
          if ($eventIndexReq === null)
            $eventIndexReq = $eventIndexOut;
          $ackIndex = null;
          if (isset($stateData['riskAreaCountdownAckIndex']) && is_numeric($stateData['riskAreaCountdownAckIndex']))
            $ackIndex = (int) $stateData['riskAreaCountdownAckIndex'];
          $timeAlive = (float) ($stateData['timeAlive'] ?? 0);
          $riskAreasRaw = isset($stateData['riskAreas']) && is_array($stateData['riskAreas']) ? $stateData['riskAreas'] : [];
          $canUpdate = ($eventIndexReq === $eventIndexOut) && ($ackIndex === null || $ackIndex < $eventIndexOut);
          if ($canUpdate && !empty($riskAreasRaw)) {
            foreach ($riskAreasRaw as &$area) {
              if (!is_array($area)) {
                $changed = true;
                $area = null;
                continue;
              }
              $area['countdownAt'] = $timeAlive;
              $area['duration'] = $durationReq;
              $area['expiresAt'] = $timeAlive + $durationReq;
              $changed = true;
            }
            unset($area);
            $riskAreasRaw = array_values(array_filter($riskAreasRaw, fn($a) => is_array($a)));
            $stateData['riskAreas'] = $riskAreasRaw;
            $stateData['riskAreaCountdownAckIndex'] = $eventIndexOut;
            write_state($stateDir, $roomId, $stateData);
            $areasOut = array_map(function ($area) use ($RISK_EVENT_DURATION) {
              return [
                'x' => (float) ($area['x'] ?? 0),
                'y' => (float) ($area['y'] ?? 0),
                'r' => (float) ($area['r'] ?? 0),
                'type' => ($area['type'] ?? 'exp') === 'melon' ? 'melon' : 'exp',
                'countdownAt' => isset($area['countdownAt']) ? (float) $area['countdownAt'] : null,
                'duration' => isset($area['duration']) ? (float) $area['duration'] : $RISK_EVENT_DURATION,
                'expiresAt' => isset($area['expiresAt']) ? (float) $area['expiresAt'] : null,
              ];
            }, $riskAreasRaw);
          }
        } finally {
          try { flock($lf2, LOCK_UN); fclose($lf2); } catch (Throwable $e) { }
        }
        if ($changed) {
          append_event($eventsDir, $roomId, [
            'type' => 'riskRewardAreas',
            'areas' => $areasOut,
            'eventIndex' => $eventIndexOut,
            'svt' => (int) round(microtime(true) * 1000),
          ]);
        }
        json_ok(['ok' => true, 'updated' => $changed]);
        break;
      } elseif (($event['type'] ?? '') === 'riskRewardActivate') {
        $areaType = isset($event['areaType']) ? (string) $event['areaType'] : '';
        if ($areaType === '' && isset($event['area']['type']))
          $areaType = (string) $event['area']['type'];
        if ($areaType !== 'exp' && $areaType !== 'melon') {
          json_error('無効なエリア種別です', 400);
          break;
        }
        $lockFile = $stateDir . '/sim_' . $roomId . '.lock';
        $lf2 = fopen($lockFile, 'c+');
        if (!$lf2) {
          json_error('現在この操作は行えません', 409);
          break;
        }
        if (!flock($lf2, LOCK_EX)) {
          fclose($lf2);
          json_error('現在この操作は行えません', 409);
          break;
        }
        $error = null;
        $effectPayload = null;
        $spawned = 0;
        $areasOut = [];
        try {
          $stateData = read_state($stateDir, $roomId);
          $stateData = ensure_state_shape($stateData);
          $riskAreasRaw = isset($stateData['riskAreas']) && is_array($stateData['riskAreas']) ? $stateData['riskAreas'] : [];
          $targetIdx = null;
          foreach ($riskAreasRaw as $idx => $area) {
            if (($area['type'] ?? '') === $areaType) {
              $targetIdx = $idx;
              break;
            }
          }
          if ($targetIdx === null) {
            $error = ['msg' => '対象のエリアが見つかりません', 'code' => 404];
          } else {
            $targetArea = $riskAreasRaw[$targetIdx];
            $timeAlive = (float) ($stateData['timeAlive'] ?? 0);
            $expiresAt = isset($targetArea['expiresAt']) ? (float) $targetArea['expiresAt'] : ($timeAlive + 1);
            if ($expiresAt <= $timeAlive) {
              $error = ['msg' => 'エリアの有効時間が切れています', 'code' => 409];
            }
          }
          $playersPos = [];
          if ($error === null) {
            $nowSeen = microtime(true);
            if (isset($stateData['players']) && is_array($stateData['players'])) {
              foreach ($stateData['players'] as $pid => $snap) {
                if (!is_array($snap))
                  continue;
                if (isset($snap['alive']) && !$snap['alive'])
                  continue;
                $seen = (float) ($snap['lastSeen'] ?? 0);
                if ($seen <= 0 || ($nowSeen - $seen) > 60)
                  continue;
                if (!isset($snap['x']) || !isset($snap['y']))
                  continue;
                $playersPos[] = ['id' => $pid, 'x' => (float) $snap['x'], 'y' => (float) $snap['y']];
              }
            }
            if (empty($playersPos) && is_array($authRoom)) {
              foreach ($authRoom['members'] ?? [] as $member) {
                if (($member['id'] ?? '') === '')
                  continue;
                if (!empty($member['dead']))
                  continue;
                $seen = (float) ($member['lastSeen'] ?? 0);
                if ($nowSeen - $seen > 60)
                  continue;
                if (!isset($member['x']) || !isset($member['y']))
                  continue;
                $playersPos[] = ['id' => $member['id'], 'x' => (float) $member['x'], 'y' => (float) $member['y']];
              }
            }
            if (empty($playersPos)) {
              $error = ['msg' => 'プレイヤー位置を取得できませんでした', 'code' => 409];
            }
          }
          if ($error === null) {
            $radius = isset($targetArea['r']) ? (float) $targetArea['r'] : 90.0;
            $centerX = (float) ($targetArea['x'] ?? 0);
            $centerY = (float) ($targetArea['y'] ?? 0);
            foreach ($playersPos as $pp) {
              $dist = hypot($pp['x'] - $centerX, $pp['y'] - $centerY);
              if (!is_finite($dist) || $dist >= $radius) {
                $error = ['msg' => '全員がエリア内にいません', 'code' => 409];
                break;
              }
            }
          }
          if ($error === null) {
            $timeAlive = (float) ($stateData['timeAlive'] ?? 0);
            $stageName = (string) ($authRoom['stage'] ?? 'メロンパン広場');
            $stageCfg = build_stage_config($stageName);
            $diffName = (string) ($authRoom['difficulty'] ?? 'ふつう');
            $diffBulletMul = 0.8;
            $diffBulletDmgMul = 0.75;
            $diffMobHpMul = 1.0;
            if ($diffName === 'かんたん') {
              $diffBulletMul = 0.6;
              $diffBulletDmgMul = 0.5;
              $diffMobHpMul = 1.0;
            } elseif ($diffName === 'むずかしい') {
              $diffBulletMul = 1.0;
              $diffBulletDmgMul = 1.0;
              $diffMobHpMul = 2.0;
            }
            if ($diffName === 'むずかしい' && room_has_ignition($authRoom ?? [])) {
              $diffBulletMul = 1.5;
              $diffBulletDmgMul = 2.0;
            }
            $riskEnemyConfigs = [
              'かんたん' => ['count' => 2, 'hp' => 260, 'interval' => 2.4, 'volley' => 16, 'rings' => 1, 'bulletSpeed' => 90, 'bulletTtl' => 5.6, 'bulletDmg' => 5, 'sprayInterval' => 1.2, 'sprayShots' => 4, 'spraySpeed' => 80, 'spd' => 36, 'fan' => 0.45],
              'ふつう' => ['count' => 3, 'hp' => 320, 'interval' => 2.0, 'volley' => 20, 'rings' => 1, 'bulletSpeed' => 110, 'bulletTtl' => 5.8, 'bulletDmg' => 7, 'sprayInterval' => 1.0, 'sprayShots' => 5, 'spraySpeed' => 95, 'spd' => 38, 'fan' => 0.48],
              'むずかしい' => ['count' => 4, 'hp' => 380, 'interval' => 1.6, 'volley' => 24, 'rings' => 2, 'bulletSpeed' => 130, 'bulletTtl' => 6.2, 'bulletDmg' => 9, 'sprayInterval' => 0.85, 'sprayShots' => 6, 'spraySpeed' => 110, 'spd' => 42, 'fan' => 0.55, 'bulletLimit' => 220],
            ];
            $cfgRisk = $riskEnemyConfigs[$diffName] ?? $riskEnemyConfigs['ふつう'];
            $hpBase = (float) ($cfgRisk['hp'] ?? 320);
            $hpMul = $diffMobHpMul * (float) ($stageCfg['mobHpMul'] ?? 1.0);
            $baseHp = max(50, (int) round(($hpBase + max(0.0, $timeAlive - 300.0) * 0.6) * $hpMul));
            $bulletDmg = max(1, (int) round(($cfgRisk['bulletDmg'] ?? 6) * $diffBulletDmgMul));
            $interval = max(0.6, ($cfgRisk['interval'] ?? 2.0) / max(0.6, $diffBulletMul));
            $sprayInterval = max(0.4, ($cfgRisk['sprayInterval'] ?? 1.0) / max(0.6, $diffBulletMul));
            $count = max(1, (int) ($cfgRisk['count'] ?? 2));
            $cx = 0.0; $cy = 0.0;
            $pc = count($playersPos);
            foreach ($playersPos as $pp) { $cx += $pp['x']; $cy += $pp['y']; }
            if ($pc > 0) { $cx /= $pc; $cy /= $pc; }
            for ($i = 0; $i < $count; $i++) {
              $tries = 12;
              $spawnR = 14.0;
              $best = null;
              while ($tries-- > 0) {
                $dist = 520.0 + (mt_rand() / mt_getrandmax()) * 240.0;
                $ang = (mt_rand() / mt_getrandmax()) * M_PI * 2;
                $px = $cx + cos($ang) * $dist;
                $py = $cy + sin($ang) * $dist;
                if (!empty($stageCfg['circular'])) {
                  $radius = (float) ($stageCfg['radius'] ?? 600.0);
                  $maxR = max(0.0, $radius - $spawnR);
                  $d0 = hypot($px, $py);
                  if ($d0 > $maxR) {
                    if ($d0 > 0) {
                      $px = ($px / $d0) * $maxR;
                      $py = ($py / $d0) * $maxR;
                    } else {
                      $px = $maxR;
                      $py = 0.0;
                    }
                  }
                }
                if (!empty($stageCfg['star'])) {
                  [$px, $py] = clamp_to_star($stageCfg, $px, $py, $spawnR);
                }
                if (($stageCfg['type'] ?? 'plaza') === 'ranch') {
                  $hh = (float) ($stageCfg['halfHeight'] ?? 140);
                  $py = max(-$hh + $spawnR, min($hh - $spawnR, $py));
                }
                $blocked = false;
                if (($stageCfg['type'] ?? 'plaza') === 'maze' && empty($stageCfg['ignoreMobWalls'])) {
                  $obs = $getNearbyObstacles($px, $py);
                  foreach ($obs as $rect) {
                    if ($circleRectCollide($px, $py, $spawnR, $rect)) {
                      $blocked = true;
                      break;
                    }
                  }
                }
                if ($blocked)
                  continue;
                if (($stageCfg['type'] ?? '') === 'volcano') {
                  $lavaX = -600.0 + (($stageCfg['lavaSpeed'] ?? 25.0) * $timeAlive);
                  $px = max($px, $lavaX + $spawnR + 1.0);
                }
                $best = [$px, $py];
                break;
              }
              if ($best === null) {
                $dist = 520.0 + (mt_rand() / mt_getrandmax()) * 240.0;
                $ang = (mt_rand() / mt_getrandmax()) * M_PI * 2;
                $px = $cx + cos($ang) * $dist;
                $py = $cy + sin($ang) * $dist;
                if (!empty($stageCfg['circular'])) {
                  $radius = (float) ($stageCfg['radius'] ?? 600.0);
                  $maxR = max(0.0, $radius - $spawnR);
                  $d0 = hypot($px, $py);
                  if ($d0 > $maxR && $d0 > 0) {
                    $px = ($px / $d0) * $maxR;
                    $py = ($py / $d0) * $maxR;
                  }
                }
                if (!empty($stageCfg['star'])) {
                  [$px, $py] = clamp_to_star($stageCfg, $px, $py, $spawnR);
                }
                if (($stageCfg['type'] ?? 'plaza') === 'ranch') {
                  $hh = (float) ($stageCfg['halfHeight'] ?? 140);
                  $py = max(-$hh + $spawnR, min($hh - $spawnR, $py));
                }
                if (($stageCfg['type'] ?? '') === 'volcano') {
                  $lavaX = -600.0 + (($stageCfg['lavaSpeed'] ?? 25.0) * $timeAlive);
                  $px = max($px, $lavaX + $spawnR + 1.0);
                }
                $best = [$px, $py];
              }
              $enemy = [
                'id' => substr(bin2hex(safe_random_bytes(6)), 0, 8),
                'type' => 'barrage',
                'name' => ($areaType === 'exp') ? '弾幕守護機' : '弾幕供給機',
                'x' => (float) $best[0],
                'y' => (float) $best[1],
                'r' => $spawnR,
                'hp' => $baseHp,
                'maxHp' => $baseHp,
                'spd' => (float) ($cfgRisk['spd'] ?? 40),
                'alive' => true,
                't' => 0,
                'interval' => $interval,
                'volley' => $cfgRisk['volley'] ?? 12,
                'rings' => $cfgRisk['rings'] ?? 1,
                'bulletSpd' => (float) ($cfgRisk['bulletSpeed'] ?? 100),
                'bulletTtl' => (float) ($cfgRisk['bulletTtl'] ?? 5.5),
                'bulletDmg' => $bulletDmg,
                'sprayInterval' => $sprayInterval,
                'sprayShots' => $cfgRisk['sprayShots'] ?? 4,
                'spraySpeed' => (float) ($cfgRisk['spraySpeed'] ?? (($cfgRisk['bulletSpeed'] ?? 100) * 0.8)),
                'fan' => (float) ($cfgRisk['fan'] ?? 0.4),
                'bulletLimit' => $cfgRisk['bulletLimit'] ?? 180,
                'cd' => (mt_rand() / mt_getrandmax()) * max(0.4, $interval),
                'sprayCd' => (mt_rand() / mt_getrandmax()) * max(0.3, $sprayInterval),
              ];
              $stateData['enemies'][] = $enemy;
              $spawned++;
            }
            $effectPayload = ['type' => $areaType, 'startedAt' => $timeAlive];
            $stateData['riskAreas'] = [];
            $stateData['riskEventEffect'] = $effectPayload;
            write_state($stateDir, $roomId, $stateData);
            $areasOut = $stateData['riskAreas'];
          }
        } finally {
          try { flock($lf2, LOCK_UN); fclose($lf2); } catch (Throwable $e) { }
        }
        if ($error !== null) {
          json_error($error['msg'], $error['code']);
          break;
        }
        $eventPayload = [
          'type' => 'riskRewardActivate',
          'effect' => $effectPayload,
          'areas' => array_map(function ($area) use ($RISK_EVENT_DURATION) {
            return [
              'x' => (float) ($area['x'] ?? 0),
              'y' => (float) ($area['y'] ?? 0),
              'r' => (float) ($area['r'] ?? 0),
              'type' => ($area['type'] ?? 'exp') === 'melon' ? 'melon' : 'exp',
              'countdownAt' => isset($area['countdownAt']) ? (float) $area['countdownAt'] : null,
              'duration' => isset($area['duration']) ? (float) $area['duration'] : $RISK_EVENT_DURATION,
              'expiresAt' => isset($area['expiresAt']) ? (float) $area['expiresAt'] : null,
            ];
          }, $areasOut),
          'areaType' => $areaType,
          'spawned' => $spawned,
          'playerId' => $playerPublicId,
          'svt' => (int) round(microtime(true) * 1000),
        ];
        append_event($eventsDir, $roomId, $eventPayload);
      } elseif (($event['type'] ?? '') === 'hit') {
        // client reports a hit on an enemy (server-authoritative damage)
        $enemyId = (string) ($event['enemyId'] ?? '');
        $dmg = (float) ($event['dmg'] ?? 0);
        if ($enemyId !== '' && $dmg > 0) {
          $skipHitProcessing = !room_member_is_active($authRoom ?? [], $playerId);
          if (!$skipHitProcessing) {
            // guard against absurd damage
            if (!is_finite($dmg) || $dmg > 1e6)
              $dmg = 1e6;
            // lock sim and apply damage
            $lockFile = $stateDir . '/sim_' . $roomId . '.lock';
            $lf2 = fopen($lockFile, 'c+');
            if (!$lf2) {
              $log->warn('events:lockOpenFailed', ['file' => $lockFile]);
            } elseif (flock($lf2, LOCK_EX)) {
              try {
                $st = read_state($stateDir, $roomId);
                if ($st && !empty($st['enemies'])) {
                  $killed = false;
                  foreach ($st['enemies'] as &$e) {
                    if (!empty($e['alive']) && ($e['id'] ?? '') === $enemyId) {
                      $hp = isset($e['hp']) ? (float) $e['hp'] : 0;
                      $mul = isset($e['dmgTakenMul']) ? (float) $e['dmgTakenMul'] : 1.0;
                      $hp -= $dmg * $mul;
                      $e['hp'] = $hp;
                      if ($hp <= 0) {
                        if (vlg_should_track_alive_counts($e)) {
                          if (!isset($st['aliveCounts']) || !is_array($st['aliveCounts']))
                            $beforeCounts = vlg_recompute_alive_counts($st);
                          else
                            $beforeCounts = vlg_normalize_alive_counts($st['aliveCounts']);
                          $afterCounts = vlg_adjust_alive_counts($st, $e, -1);
                          if ($afterCounts !== $beforeCounts) {
                            $log->debug('events:aliveCountsDelta', [
                              'roomId' => $roomId,
                              'enemyId' => $enemyId,
                              'type' => (string) ($e['type'] ?? ''),
                              'delta' => -1,
                              'source' => 'hit',
                              'counts' => $afterCounts,
                            ]);
                          }
                        }
                        $e['alive'] = false;
                        $killed = true;
                      }
                      break;
                    }
                  }
                  unset($e);
                  write_state($stateDir, $roomId, $st);
                  if ($killed) {
                    $now = time();
                    $newSvKills = null;
                    $persisted = persist_room_member_changes($roomsFile, $roomId, $playerId, function (&$room, &$member) use ($now, &$newSvKills) {
                      $member['svKills'] = (int) (($member['svKills'] ?? 0) + 1);
                      $room['updatedAt'] = $now;
                      $newSvKills = (int) $member['svKills'];
                      return true;
                    });
                    if ($persisted && $newSvKills !== null) {
                      foreach (($authRoom['members'] ?? []) as &$m2) {
                        if (($m2['id'] ?? '') !== $playerId)
                          continue;
                        $m2['svKills'] = $newSvKills;
                        $authRoom['updatedAt'] = $now;
                        break;
                      }
                      unset($m2);
                    }
                  }
                }
              } catch (Throwable $e) {
                // ignore
              } finally {
                try {
                  flock($lf2, LOCK_UN);
                  fclose($lf2);
                } catch (Throwable $e) {
                }
              }
            } else {
              if ($lf2) {
                fclose($lf2);
              }
            }
          }
        }
      } elseif (($event['type'] ?? '') === 'hits') {
        // batched hits: { hits: [{enemyId, dmg}, ...] }
        $hits = $event['hits'] ?? [];
        if (is_array($hits) && !empty($hits)) {
          $skipBatchProcessing = !room_member_is_active($authRoom ?? [], $playerId);
          if (!$skipBatchProcessing) {
            $lockFile = $stateDir . '/sim_' . $roomId . '.lock';
            $lf2 = fopen($lockFile, 'c+');
            if (!$lf2) {
              $log->warn('events:lockOpenFailed', ['file' => $lockFile]);
            } elseif (flock($lf2, LOCK_EX)) {
              $killsCount = 0;
              try {
                $st = read_state($stateDir, $roomId);
                if ($st && !empty($st['enemies'])) {
                  // fold hits by enemyId
                  $agg = [];
                  foreach ($hits as $h) {
                    $eid = (string) ($h['enemyId'] ?? '');
                    $d = (float) ($h['dmg'] ?? 0);
                    if ($eid === '' || !is_finite($d) || $d <= 0)
                      continue;
                    if ($d > 1e6)
                      $d = 1e6;
                    $agg[$eid] = ($agg[$eid] ?? 0) + $d;
                  }
                  if (!empty($agg)) {
                    foreach ($st['enemies'] as &$e) {
                      $eid = $e['id'] ?? '';
                      if ($eid !== '' && !empty($e['alive']) && isset($agg[$eid])) {
                        $hp = isset($e['hp']) ? (float) $e['hp'] : 0;
                        $mul = isset($e['dmgTakenMul']) ? (float) $e['dmgTakenMul'] : 1.0;
                        $hp -= (float) $agg[$eid] * $mul;
                        $e['hp'] = $hp;
                        if ($hp <= 0) {
                          if (vlg_should_track_alive_counts($e)) {
                            if (!isset($st['aliveCounts']) || !is_array($st['aliveCounts']))
                              $beforeCounts = vlg_recompute_alive_counts($st);
                            else
                              $beforeCounts = vlg_normalize_alive_counts($st['aliveCounts']);
                            $afterCounts = vlg_adjust_alive_counts($st, $e, -1);
                            if ($afterCounts !== $beforeCounts) {
                              $log->debug('events:aliveCountsDelta', [
                                'roomId' => $roomId,
                                'enemyId' => $eid,
                                'type' => (string) ($e['type'] ?? ''),
                                'delta' => -1,
                                'source' => 'hits',
                                'counts' => $afterCounts,
                              ]);
                            }
                          }
                          $e['alive'] = false;
                          $killsCount++;
                        }
                      }
                    }
                    unset($e);
                    write_state($stateDir, $roomId, $st);
                  }
                }
              } catch (Throwable $e) {
                // ignore
              } finally {
                try {
                  flock($lf2, LOCK_UN);
                  fclose($lf2);
                } catch (Throwable $e) {
                }
              }
              if ($killsCount > 0) {
                $now = time();
                $newSvKills = null;
                $persisted = persist_room_member_changes($roomsFile, $roomId, $playerId, function (&$room, &$member) use ($killsCount, $now, &$newSvKills) {
                  $member['svKills'] = (int) (($member['svKills'] ?? 0) + $killsCount);
                  $room['updatedAt'] = $now;
                  $newSvKills = (int) $member['svKills'];
                  return true;
                });
                if ($persisted && $newSvKills !== null) {
                  foreach (($authRoom['members'] ?? []) as &$m2) {
                    if (($m2['id'] ?? '') !== $playerId)
                      continue;
                    $m2['svKills'] = $newSvKills;
                    $authRoom['updatedAt'] = $now;
                    break;
                  }
                  unset($m2);
                }
              }
            } else {
              if ($lf2) {
                fclose($lf2);
              }
            }
          }
        }
      } elseif (($event['type'] ?? '') === 'exp') {
        // Ignored: battle EXP is now tracked entirely on each client.
        // Keep the branch so legacy clients can POST without causing errors.
      } elseif (($event['type'] ?? '') === 'heal') {
        $itemId = $event['itemId'] ?? '';
        if ($itemId !== '') {
          $lockFile = $stateDir . '/sim_' . $roomId . '.lock';
          $lf2 = fopen($lockFile, 'c+');
          if (!$lf2) {
            $log->warn('events:lockOpenFailed', ['file' => $lockFile]);
          } elseif ($lf2 && flock($lf2, LOCK_EX)) {
            try {
              $st = read_state($stateDir, $roomId);
              $items = $st['items'] ?? [];
              $found = -1; $healVal = 0;
              foreach ($items as $idx => $it) {
                if (($it['id'] ?? '') === $itemId) { $found = $idx; $healVal = (float) ($it['value'] ?? 20); break; }
              }
              if ($found >= 0) {
                $now = time();
                $lastSeen = microtime(true);
                $newHp = null;
                $persisted = persist_room_member_changes($roomsFile, $roomId, $playerId, function (&$room, &$member) use ($healVal, $now, $lastSeen, &$newHp) {
                  if (!empty($member['dead']) || (isset($member['alive']) && !$member['alive']))
                    return false;
                  $curHp = (float) ($member['hp'] ?? 0);
                  $maxHp = (float) ($member['maxHp'] ?? $curHp);
                  $newHp = min($maxHp, $curHp + $healVal);
                  $member['hp'] = $newHp;
                  $member['lastSeen'] = $lastSeen;
                  $room['updatedAt'] = $now;
                  return true;
                });
                if ($persisted && $newHp !== null) {
                  foreach (($authRoom['members'] ?? []) as &$m) {
                    if (($m['id'] ?? '') !== $playerId)
                      continue;
                    $m['hp'] = $newHp;
                    $m['lastSeen'] = $lastSeen;
                    $authRoom['updatedAt'] = $now;
                    unset($m);
                    break;
                  }
                  unset($m);
                  array_splice($items, $found, 1);
                  $st['items'] = $items;
                  write_state($stateDir, $roomId, $st);
                  $payload = ['type' => 'heal', 'playerId' => $playerPublicId, 'hp' => $newHp];
                  append_event($eventsDir, $roomId, $payload);
                }
              }
            } finally {
              try { flock($lf2, LOCK_UN); fclose($lf2); } catch (Throwable $e) { }
            }
          } else {
            if ($lf2) {
              fclose($lf2);
            }
          }
        }
      } elseif (($event['type'] ?? '') === 'revive') {
        $targetPublic = isset($event['target']) ? (string) $event['target'] : '';
        if ($targetPublic !== '' && $playerPublicId !== null) {
          $targetPrivate = get_member_private_id($authRoom ?? [], $targetPublic);
          if ($targetPrivate !== null && $targetPrivate !== $playerId) {
            $data = read_json($roomsFile);
            $now = time();
            $applied = false;
            $revivePayload = null;
            $reviverPublic = $playerPublicId;
            foreach ($data['rooms'] as &$room) {
              if (($room['id'] ?? '') !== $roomId)
                continue;
              $sourceAlive = false;
              foreach ($room['members'] as $m) {
                if (($m['id'] ?? '') !== $playerId)
                  continue;
                if (!empty($m['dead']) || (isset($m['alive']) && !$m['alive']))
                  $sourceAlive = false;
                else
                  $sourceAlive = true;
                break;
              }
              if (!$sourceAlive)
                break;
              foreach ($room['members'] as &$m) {
                if (($m['id'] ?? '') !== $targetPrivate)
                  continue;
                $isDead = !empty($m['dead']) || (isset($m['alive']) && !$m['alive']);
                if (!$isDead)
                  break 2;
                if (!empty($m['reviveUsed']))
                  break 2;
                $maxHpVal = isset($m['maxHp']) ? (float) $m['maxHp'] : null;
                $currentHpVal = isset($m['hp']) ? (float) $m['hp'] : null;
                $baseHp = $maxHpVal !== null ? $maxHpVal : ($currentHpVal !== null ? $currentHpVal : 0.0);
                $newHp = (float) max(1, floor($baseHp * 0.5));
                if ($maxHpVal === null && $baseHp <= 0)
                  $newHp = 1.0;
                $effectiveMaxHp = $maxHpVal;
                if ($effectiveMaxHp === null || $effectiveMaxHp <= 0) {
                  if ($baseHp > 0)
                    $effectiveMaxHp = $baseHp;
                  else
                    $effectiveMaxHp = $newHp;
                }
                $m['hp'] = $newHp;
                if ($effectiveMaxHp !== null)
                  $m['maxHp'] = $effectiveMaxHp;
                $m['alive'] = true;
                unset($m['dead']);
                $m['reviveUsed'] = true;
                $m['lastSeen'] = microtime(true);
                $room['updatedAt'] = $now;
                $revivePayload = [
                  'hp' => $newHp,
                  'maxHp' => $effectiveMaxHp,
                  'armor' => isset($m['armor']) ? (float) $m['armor'] : null,
                  'maxArmor' => isset($m['maxArmor']) ? (float) $m['maxArmor'] : null,
                  'x' => isset($m['x']) ? (float) $m['x'] : null,
                  'y' => isset($m['y']) ? (float) $m['y'] : null,
                ];
                $applied = true;
                break;
              }
              unset($m);
              if ($applied) {
                write_json($roomsFile, $data);
                $targetPublicOut = get_member_public_id($room, $targetPrivate) ?? $targetPublic;
                $reviverPublic = get_member_public_id($room, $playerId) ?? $playerPublicId;
                $payload = [
                  'type' => 'revive',
                  'playerId' => $targetPublicOut,
                  'hp' => $revivePayload['hp'],
                  'revived' => true,
                  'reviverId' => $reviverPublic,
                ];
                if ($revivePayload['maxHp'] !== null)
                  $payload['maxHp'] = $revivePayload['maxHp'];
                if ($revivePayload['armor'] !== null)
                  $payload['armor'] = $revivePayload['armor'];
                if ($revivePayload['maxArmor'] !== null)
                  $payload['maxArmor'] = $revivePayload['maxArmor'];
                if ($revivePayload['x'] !== null && $revivePayload['y'] !== null) {
                  $payload['x'] = $revivePayload['x'];
                  $payload['y'] = $revivePayload['y'];
                }
                append_event($eventsDir, $roomId, $payload);
                if (is_array($authRoom)) {
                  foreach ($authRoom['members'] as &$mAuth) {
                    if (($mAuth['id'] ?? '') !== $targetPrivate)
                      continue;
                    $mAuth['hp'] = $revivePayload['hp'];
                    if ($revivePayload['maxHp'] !== null)
                      $mAuth['maxHp'] = $revivePayload['maxHp'];
                    if ($revivePayload['armor'] !== null)
                      $mAuth['armor'] = $revivePayload['armor'];
                    if ($revivePayload['maxArmor'] !== null)
                      $mAuth['maxArmor'] = $revivePayload['maxArmor'];
                    $mAuth['alive'] = true;
                    unset($mAuth['dead']);
                    $mAuth['reviveUsed'] = true;
                    $mAuth['lastSeen'] = microtime(true);
                    break;
                  }
                  unset($mAuth);
                }
                break;
              }
              break;
            }
            unset($room);
          }
        }
        break;
      } elseif (($event['type'] ?? '') === 'allyHeal') {
        $targetPublic = isset($event['target']) ? (string) $event['target'] : '';
        $gain = (float) ($event['v'] ?? 0);
        if ($targetPublic !== '' && $gain > 0) {
          $target = get_member_private_id($authRoom ?? [], $targetPublic);
          if ($target !== null) {
            $data = read_json($roomsFile);
            $sourceAlive = false;
            foreach ($data['rooms'] as $room) {
              if (($room['id'] ?? '') !== $roomId) continue;
              foreach ($room['members'] as $m) {
                if (($m['id'] ?? '') !== $playerId) continue;
                if (!empty($m['dead']) || (isset($m['alive']) && !$m['alive'])) break 2;
                $sourceAlive = true;
                break 2;
              }
              break;
            }
            if ($sourceAlive) {
              foreach ($data['rooms'] as &$room) {
                if (($room['id'] ?? '') !== $roomId) continue;
                foreach ($room['members'] as &$m) {
                  if (($m['id'] ?? '') !== $target) continue;
                  if (!empty($m['dead']) || (isset($m['alive']) && !$m['alive'])) { break 2; }
                  $curHp = (float) ($m['hp'] ?? 0); $maxHp = (float) ($m['maxHp'] ?? $curHp);
                  $newHp = min($maxHp, $curHp + $gain);
                  $m['hp'] = $newHp; $m['lastSeen'] = microtime(true);
                  $room['updatedAt'] = time();
                  write_json($roomsFile, $data);
                  $targetPublicOut = get_member_public_id($room, $target) ?? $targetPublic;
                  $payload = ['type' => 'heal', 'playerId' => $targetPublicOut, 'hp' => $newHp];
                  append_event($eventsDir, $roomId, $payload);
                  unset($m);
                  unset($room);
                  break 2;
                }
                unset($m);
                break;
              }
              unset($room);
            }
          }
        }
      } elseif (($event['type'] ?? '') === 'stuns') {
        $entries = $event['stuns'] ?? [];
        if (is_array($entries) && !empty($entries)) {
          $lockFile = $stateDir . '/sim_' . $roomId . '.lock';
          $lf2 = fopen($lockFile, 'c+');
          $toEmit = [];
          if (!$lf2) {
            $log->warn('events:lockOpenFailed', ['file' => $lockFile]);
          } elseif ($lf2 && flock($lf2, LOCK_EX)) {
            try {
              $st = read_state($stateDir, $roomId);
              if (!is_array($st))
                $st = [];
              $enemies = $st['enemies'] ?? [];
              $processed = false;
              foreach ($entries as $entry) {
                if (!is_array($entry))
                  continue;
                $enemyId = isset($entry['enemyId']) ? (string) $entry['enemyId'] : '';
                $dur = isset($entry['dur']) ? (float) $entry['dur'] : 0.0;
                if ($enemyId === '' || !is_finite($dur) || $dur <= 0)
                  continue;
                $processed = true;
                foreach ($enemies as &$en) {
                  if (($en['id'] ?? '') === $enemyId) {
                    $en['stun'] = max($dur, (float) ($en['stun'] ?? 0));
                    break;
                  }
                }
                unset($en);
                $toEmit[] = ['type' => 'stun', 'id' => $enemyId, 'dur' => $dur];
              }
              if ($processed) {
                $st['enemies'] = $enemies;
                write_state($stateDir, $roomId, $st);
              }
            } finally {
              try {
                flock($lf2, LOCK_UN);
                fclose($lf2);
              } catch (Throwable $e) {
              }
            }
          } else {
            if ($lf2) {
              fclose($lf2);
            }
          }
          if (!empty($toEmit)) {
            foreach ($toEmit as $payload) {
              append_event($eventsDir, $roomId, $payload);
            }
          }
        }
      } elseif (($event['type'] ?? '') === 'stun') {
        $enemyId = $event['enemyId'] ?? '';
        $dur = (float) ($event['dur'] ?? 0);
        if ($enemyId !== '' && $dur > 0) {
          $lockFile = $stateDir . '/sim_' . $roomId . '.lock';
          $lf2 = fopen($lockFile, 'c+');
          if (!$lf2) {
            $log->warn('events:lockOpenFailed', ['file' => $lockFile]);
          } elseif ($lf2 && flock($lf2, LOCK_EX)) {
            try {
              $st = read_state($stateDir, $roomId);
              $enemies = $st['enemies'] ?? [];
              foreach ($enemies as &$en) {
                if (($en['id'] ?? '') === $enemyId) { $en['stun'] = max($dur, (float) ($en['stun'] ?? 0)); break; }
              }
              unset($en);
              $st['enemies'] = $enemies;
              write_state($stateDir, $roomId, $st);
              append_event($eventsDir, $roomId, ['type' => 'stun', 'id' => $enemyId, 'dur' => $dur]);
            } finally { try { flock($lf2, LOCK_UN); fclose($lf2); } catch (Throwable $e) { } }
          } else {
            if ($lf2) {
              fclose($lf2);
            }
          }
        }
      } elseif (($event['type'] ?? '') === 'attr') {
        $itemId = $event['itemId'] ?? '';
        $elem = $event['elem'] ?? '';
        if ($itemId !== '' && in_array($elem, ['fire', 'ice', 'lightning', 'dark'], true)) {
          $lockFile = $stateDir . '/sim_' . $roomId . '.lock';
          $lf2 = fopen($lockFile, 'c+');
          if (!$lf2) {
            $log->warn('events:lockOpenFailed', ['file' => $lockFile]);
          } elseif ($lf2 && flock($lf2, LOCK_EX)) {
            try {
              $st = read_state($stateDir, $roomId);
              $items = $st['items'] ?? [];
              $found = -1;
              foreach ($items as $idx => $it) {
                if (($it['id'] ?? '') === $itemId) { $found = $idx; break; }
              }
              if ($found >= 0) {
                array_splice($items, $found, 1);
                $st['items'] = $items;
                write_state($stateDir, $roomId, $st);
                $data = read_json($roomsFile);
                foreach ($data['rooms'] as &$room) {
                  if (($room['id'] ?? '') !== $roomId) continue;
                  foreach ($room['members'] as &$m) {
                    if (($m['id'] ?? '') !== $playerId) continue;
                    $m['elem'] = $elem;
                    $m['lastSeen'] = microtime(true);
                    break;
                  }
                  unset($m);
                  $room['updatedAt'] = time();
                  break;
                }
                unset($room);
                write_json($roomsFile, $data);
                $payload = ['type' => 'attr', 'playerId' => $playerPublicId, 'elem' => $elem];
                append_event($eventsDir, $roomId, $payload);
              }
            } finally {
              try { flock($lf2, LOCK_UN); fclose($lf2); } catch (Throwable $e) { }
            }
          } else {
            if ($lf2) {
              fclose($lf2);
            }
          }
        }
      } elseif (($event['type'] ?? '') === 'pause' || ($event['type'] ?? '') === 'resume') {
        $type = $event['type'];
        $data = read_json($roomsFile);
        global $PAUSE_TTL_SEC;
        $tokenVal = normalize_pause_token($event['token'] ?? null);
        $accepted = false;
        foreach ($data['rooms'] as &$room) {
          if (($room['id'] ?? '') !== $roomId) continue;
          touch_member($room, $playerId);
          $room['updatedAt'] = time();
          $pidStr = (string) $playerId;
          $pb = [];
          if (isset($room['pauseBy']) && is_array($room['pauseBy'])) {
            foreach ($room['pauseBy'] as $p) {
              if ($p === null) continue;
              $pb[] = (string) $p;
            }
          }
          $pauseTimes = normalize_pause_times($room['pauseTimes'] ?? []);
          $pauseTokens = normalize_pause_token_map($room['pauseTokens'] ?? []);
          $lastToken = $pauseTokens[$pidStr] ?? null;
          if ($type === 'pause') {
            if ($tokenVal !== null && $lastToken !== null && $tokenVal < $lastToken) {
              break;
            }
            if (!in_array($pidStr, $pb, true)) {
              $pb[] = $pidStr;
            }
            if ($tokenVal !== null)
              $pauseTokens[$pidStr] = $tokenVal;
            if ($pidStr !== 'boss' && $pidStr !== 'server') {
              $pauseTimes[$pidStr] = ['ts' => microtime(true), 'publicId' => $playerPublicId];
            } else {
              $pauseTimes[$pidStr] = ['ts' => microtime(true)];
            }
          } else {
            if ($tokenVal !== null && $lastToken !== null && $tokenVal < $lastToken) {
              break;
            }
            if ($tokenVal !== null)
              $pauseTokens[$pidStr] = $tokenVal;
            $pb = array_values(array_filter($pb, function ($p) use ($pidStr) {
              return $p !== $pidStr;
            }));
            unset($pauseTimes[$pidStr]);
          }
          $room['pauseBy'] = $pb;
          if (!empty($pauseTimes)) {
            $room['pauseTimes'] = encode_pause_times($pauseTimes);
          } else {
            unset($room['pauseTimes']);
          }
          if (!empty($pauseTokens)) {
            $room['pauseTokens'] = $pauseTokens;
          } else {
            unset($room['pauseTokens']);
          }
          cleanup_room_pause_flags($room, $roomId, $eventsDir, $PAUSE_TTL_SEC);
          $accepted = true;
          break;
        }
        unset($room);
        if ($accepted) {
          write_json($roomsFile, $data);
          $payload = ['type' => $type, 'playerId' => $playerPublicId, 'privateId' => $playerId];
          if ($tokenVal !== null)
            $payload['token'] = $tokenVal;
          append_event($eventsDir, $roomId, $payload);
        }
      } elseif (($event['type'] ?? '') === 'pos') {
        // position broadcast for allies + persist into room state for server sim
        $sanitizeFinite = static function ($value): ?float {
          if ($value === null)
            return null;
          if (is_string($value)) {
            if ($value === '' || !is_numeric($value))
              return null;
            $num = (float) $value;
          } elseif (is_int($value) || is_float($value)) {
            $num = (float) $value;
          } else {
            return null;
          }
          return is_finite($num) ? $num : null;
        };
        $x = $sanitizeFinite($event['x'] ?? null);
        $y = $sanitizeFinite($event['y'] ?? null);
        $posValid = $x !== null && $y !== null;
        if (($x === null || $y === null) && (array_key_exists('x', $event) || array_key_exists('y', $event))) {
          $log->warn('pos:invalidCoordinates', [
            'roomId' => $roomId,
            'playerId' => $playerId,
            'x' => $event['x'] ?? null,
            'y' => $event['y'] ?? null,
          ]);
        }
        $alive = !empty($event['alive']);
        $hpInput = $sanitizeFinite($event['hp'] ?? null);
        $maxHpInput = $sanitizeFinite($event['maxHp'] ?? null);
        $armorInput = $sanitizeFinite($event['armor'] ?? null);
        $maxArmorInput = $sanitizeFinite($event['maxArmor'] ?? null);
        $tsInput = $sanitizeFinite($event['ts'] ?? null); // client-sent timestamp (ms)
        $decoysInput = $event['decoys'] ?? null;
        $nowSeen = microtime(true);
        $snapshot = [
          'alive' => (bool) $alive,
          'lastSeen' => $nowSeen,
        ];
        if ($posValid) {
          $snapshot['x'] = $x;
          $snapshot['y'] = $y;
        }
        if ($hpInput !== null)
          $snapshot['hp'] = $hpInput;
        if ($maxHpInput !== null)
          $snapshot['maxHp'] = $maxHpInput;
        if ($armorInput !== null)
          $snapshot['armor'] = $armorInput;
        if ($maxArmorInput !== null)
          $snapshot['maxArmor'] = $maxArmorInput;
        if ($tsInput !== null)
          $snapshot['ts'] = $tsInput;
        if (is_array($decoysInput)) {
          $sanitizedDecoys = [];
          $limit = 16;
          foreach ($decoysInput as $entry) {
            if (!is_array($entry))
              continue;
            if (count($sanitizedDecoys) >= $limit)
              break;
            $dx = isset($entry['x']) ? (float) $entry['x'] : null;
            $dy = isset($entry['y']) ? (float) $entry['y'] : null;
            if ($dx === null || $dy === null)
              continue;
            if (!is_finite($dx) || !is_finite($dy))
              continue;
            $decoy = ['x' => $dx, 'y' => $dy];
            if (isset($entry['hp'])) {
              $hpVal = (float) $entry['hp'];
              if (is_finite($hpVal))
                $decoy['hp'] = $hpVal;
            }
            if (isset($entry['maxHp'])) {
              $hpMax = (float) $entry['maxHp'];
              if (is_finite($hpMax))
                $decoy['maxHp'] = $hpMax;
            }
            $sanitizedDecoys[] = $decoy;
          }
          $snapshot['decoys'] = $sanitizedDecoys;
          $snapshot['decoysSeen'] = $nowSeen;
        }
        $update = update_player_snapshot($stateDir, $roomId, $playerId, $snapshot);
        $stateAfter = $update['state'] ?? null;
        $currSnapshot = isset($update['player']) && is_array($update['player']) ? $update['player'] : null;
        $prevSnapshot = isset($update['prev']) && is_array($update['prev']) ? $update['prev'] : null;
        $snapshotValue = static function (?array $snap, string $key) use ($sanitizeFinite): ?float {
          if (!is_array($snap) || !array_key_exists($key, $snap))
            return null;
          return $sanitizeFinite($snap[$key]);
        };
        $currSnapshotX = $snapshotValue($currSnapshot, 'x');
        $currSnapshotY = $snapshotValue($currSnapshot, 'y');
        $prevSnapshotX = $snapshotValue($prevSnapshot, 'x');
        $prevSnapshotY = $snapshotValue($prevSnapshot, 'y');
        $resolvedX = $currSnapshotX !== null ? $currSnapshotX : $prevSnapshotX;
        $resolvedY = $currSnapshotY !== null ? $currSnapshotY : $prevSnapshotY;
        $hasResolvedPos = $resolvedX !== null && $resolvedY !== null;
        $hpValue = $snapshotValue($currSnapshot, 'hp');
        if ($hpValue === null)
          $hpValue = $snapshotValue($prevSnapshot, 'hp');
        $maxHpValue = $snapshotValue($currSnapshot, 'maxHp');
        if ($maxHpValue === null)
          $maxHpValue = $snapshotValue($prevSnapshot, 'maxHp');
        $armorValue = $snapshotValue($currSnapshot, 'armor');
        if ($armorValue === null)
          $armorValue = $snapshotValue($prevSnapshot, 'armor');
        $maxArmorValue = $snapshotValue($currSnapshot, 'maxArmor');
        if ($maxArmorValue === null)
          $maxArmorValue = $snapshotValue($prevSnapshot, 'maxArmor');
        $tsValue = $snapshotValue($currSnapshot, 'ts');
        if ($tsValue === null)
          $tsValue = $snapshotValue($prevSnapshot, 'ts');
        if (!$hasResolvedPos && !$posValid && ($currSnapshotX === null || $currSnapshotY === null) && ($prevSnapshotX === null || $prevSnapshotY === null)) {
          $log->warn('pos:missingResolvedCoordinates', [
            'roomId' => $roomId,
            'playerId' => $playerId,
          ]);
        }
        $name = null;
        $elem = null;
        $reviveUsed = false;
        if (is_array($authRoom)) {
          foreach ($authRoom['members'] ?? [] as $m0) {
            if (($m0['id'] ?? '') !== $playerId)
              continue;
            $name = $m0['name'] ?? null;
            $elem = $m0['elem'] ?? null;
            $reviveUsed = !empty($m0['reviveUsed']);
            break;
          }
        }
        $moved = false;
        if ($prevSnapshotX !== null && $prevSnapshotY !== null && $currSnapshotX !== null && $currSnapshotY !== null) {
          if (abs($prevSnapshotX - $currSnapshotX) > 1e-6 || abs($prevSnapshotY - $currSnapshotY) > 1e-6)
            $moved = true;
        }
        $shouldSyncRooms = false;
        $stateLastSync = 0.0;
        if (!is_array($stateAfter)) {
          $shouldSyncRooms = true;
        } else {
          $stateLastSync = (float) ($stateAfter['playersLastRoomsSync'] ?? 0);
        }
        $currentAliveFlag = $alive;
        if (is_array($currSnapshot) && array_key_exists('alive', $currSnapshot))
          $currentAliveFlag = (bool) $currSnapshot['alive'];
        $previousAliveFlag = $currentAliveFlag;
        if (is_array($prevSnapshot) && array_key_exists('alive', $prevSnapshot))
          $previousAliveFlag = (bool) $prevSnapshot['alive'];
        if ($prevSnapshot === null)
          $shouldSyncRooms = true;
        if ($previousAliveFlag !== $currentAliveFlag)
          $shouldSyncRooms = true;
        if (!$shouldSyncRooms) {
          if ($stateLastSync <= 0 || ($nowSeen - $stateLastSync) >= 1.0)
            $shouldSyncRooms = true;
        }
        if ($shouldSyncRooms) {
          $data = read_json($roomsFile);
          foreach ($data['rooms'] as &$room) {
            if (($room['id'] ?? '') !== $roomId)
              continue;
            foreach ($room['members'] as &$m) {
              if (($m['id'] ?? '') !== $playerId)
                continue;
              $prevMemberX = $m['x'] ?? null;
              $prevMemberY = $m['y'] ?? null;
              if ($hasResolvedPos) {
                $m['x'] = $resolvedX;
                $m['y'] = $resolvedY;
              }
              $m['alive'] = (bool) $alive;
              if ($hpValue !== null)
                $m['hp'] = $hpValue;
              if ($maxHpValue !== null)
                $m['maxHp'] = $maxHpValue;
              if ($armorValue !== null)
                $m['armor'] = $armorValue;
              if ($maxArmorValue !== null)
                $m['maxArmor'] = $maxArmorValue;
              $m['lastSeen'] = $nowSeen;
              if (!$moved && $hasResolvedPos && $prevMemberX !== null && $prevMemberY !== null && ($prevMemberX != $resolvedX || $prevMemberY != $resolvedY))
                $moved = true;
              $name = $m['name'] ?? $name;
              $elem = $m['elem'] ?? $elem;
              break;
            }
            unset($m);
            $room['updatedAt'] = time();
            break;
          }
          unset($room);
          write_json($roomsFile, $data);
          update_player_snapshot($stateDir, $roomId, $playerId, [], function (&$state, &$entry, $prev) use ($nowSeen) {
            $prevSync = (float) ($state['playersLastRoomsSync'] ?? 0);
            if ($nowSeen > $prevSync) {
              $state['playersLastRoomsSync'] = $nowSeen;
              return true;
            }
            return false;
          });
        }
        if ($hasResolvedPos) {
          $payload = ['type' => 'allyPos', 'playerId' => $playerPublicId, 'x' => $resolvedX, 'y' => $resolvedY, 'alive' => (bool) $alive, 'name' => $name];
          if ($hpValue !== null)
            $payload['hp'] = $hpValue;
          if ($maxHpValue !== null)
            $payload['maxHp'] = $maxHpValue;
          if ($armorValue !== null)
            $payload['armor'] = $armorValue;
          if ($maxArmorValue !== null)
            $payload['maxArmor'] = $maxArmorValue;
          if ($tsValue !== null)
            $payload['ts'] = $tsValue;
          if ($elem !== null)
            $payload['elem'] = $elem;
          if ($reviveUsed)
            $payload['revived'] = true;
          // server receive time (ms)
          $payload['svt'] = (int) round(microtime(true) * 1000);
          append_event($eventsDir, $roomId, $payload);
          if ($moved) {
            try { simulate_enemies($roomsFile, $stateDir, $eventsDir, $roomId); } catch (Throwable $e) { }
          }
        }
      } elseif (($event['type'] ?? '') === 'heartbeat') {
        // lightweight presence update from client while待機中
        $data = read_json($roomsFile);
        $touched = false;
        $roomCopy = null;
        foreach ($data['rooms'] as &$room) {
          if (($room['id'] ?? '') !== $roomId)
            continue;
          if (touch_member($room, $playerId)) {
            $room['updatedAt'] = time();
            $touched = true;
            $roomCopy = $room;
          }
          break;
        }
        unset($room);
        if ($touched)
          write_json($roomsFile, $data);
      } elseif (($event['type'] ?? '') === 'backToRoom') {
        // Owner can force everyone back to the room screen
        $data = read_json($roomsFile);
        $updatedRoomCopy = null;
        foreach ($data['rooms'] as &$room) {
          if ($room['id'] !== $roomId)
            continue;
          if (($room['owner'] ?? '') !== $playerId) {
            json_error('部屋に戻す操作は部屋主のみ可能です', 403);
            return;
          }
          // reset status and flags
          $room['status'] = 'room';
          foreach ($room['members'] as &$m) {
            $m['ready'] = false;
            unset($m['dead']);
            unset($m['lastKills']);
            unset($m['lastDuration']);
            unset($m['svKills']);
            unset($m['reviveUsed']);
          }
          unset($m);
          unset($room['gameStartAt']);
          unset($room['pauseBy']);
          unset($room['simEnemies']);
          $room['updatedAt'] = time();
          $updatedRoomCopy = $room;
          break;
        }
        unset($room);
        write_json($roomsFile, $data);
        // clear sim state file
        $stateFile = $stateDir . '/' . $roomId . '.json';
        if (file_exists($stateFile) && !unlink($stateFile)) {
          $log->warn('backToRoom:unlinkFailed', ['file' => $stateFile]);
        }
        if ($updatedRoomCopy !== null) {
          // notify clients to switch screen and then push room state
          clear_event_log($eventsDir, $roomId);
          append_event($eventsDir, $roomId, ['type' => 'backToRoom']);
          append_event($eventsDir, $roomId, ['type' => 'roomUpdate', 'room' => room_public_payload($updatedRoomCopy)]);
        }
        $log->info('backToRoom', ['roomId' => $roomId, 'by' => $playerId]);
      }
      json_ok(['rid' => $rid]);
      break;

    case 'disbandRoom':
      // owner-only: delete the room and notify members
      $input = decode_json_body('disbandRoom');
      if ($input === null)
        break;
      $roomId = $input['roomId'] ?? '';
      $playerId = $input['playerId'] ?? '';
      $authToken = $input['authToken'] ?? '';
      $data = read_json($roomsFile);
      foreach ($data['rooms'] as $i => $room) {
        if ($room['id'] === $roomId) {
          ensure_room_security($room);
          $auth = authenticate_room_member($room, $playerId, $authToken);
          if (!$auth['ok']) {
            if ($auth['reason'] === 'notFound') {
              json_error('プレイヤーが見つかりません', 404);
            } else {
              json_error('認証に失敗しました', 401);
            }
            return;
          }
          if (($room['owner'] ?? '') !== $playerId) {
            $log->warn('disbandRoom:forbidden', ['roomId' => $roomId, 'playerId' => $playerId]);
            json_error('オーナーのみ解散できます', 403);
            return;
          }
          // notify via SSE log first
          clear_event_log($eventsDir, $roomId);
          append_event($eventsDir, $roomId, ['type' => 'roomClosed', 'reason' => 'disband']);
          // remove from rooms list
          array_splice($data['rooms'], $i, 1);
          write_json($roomsFile, $data);
          // cleanup simulation state files immediately after disbanding
          @unlink("$stateDir/$roomId.json");
          @unlink("$stateDir/sim_$roomId.lock");
          $log->info('disbandRoom', ['roomId' => $roomId, 'by' => $playerId]);
          json_ok(['rid' => $rid]);
          return;
        }
      }
      $log->warn('disbandRoom:notFound', ['roomId' => $roomId]);
      json_error('部屋が見つかりません', 404);
      break;

    case 'health':
      // lightweight readiness/liveness
      $ok = is_dir($eventsDir) && is_file($roomsFile);
      if ($ok) {
        json_ok(['rid' => $rid, 'env' => vlg_config()['env']]);
      } else {
        json_error('degraded', 503);
      }
      break;

    case 'events':
      // SSE: stream events for a room and periodic room list
      $roomId = $_GET['roomId'] ?? '';
      if ($roomId !== '' && !preg_match('/^[A-Za-z0-9]+$/', $roomId)) {
        json_error('invalid roomId');
        break;
      }
      $playerId = $_GET['playerId'] ?? ($_SERVER['HTTP_X_PLAYER_ID'] ?? '');
      $authToken = $_GET['authToken'] ?? ($_SERVER['HTTP_X_AUTH_TOKEN'] ?? '');
      if (!is_string($playerId))
        $playerId = '';
      if (!is_string($authToken))
        $authToken = '';
      $roomsCache = null;
      $roomsCacheMtime = null;
      $roomsCacheHash = null;
      $roomsCacheLastLoad = 0.0;
      $cachedRoomStatus = null;
      $lastRoomStatusCheck = 0.0;
      $readRoomsRaw = static function () use ($roomsFile) {
        $fh = @fopen($roomsFile, 'r');
        if ($fh === false)
          return null;
        if (!flock($fh, LOCK_SH)) {
          fclose($fh);
          return null;
        }
        $content = stream_get_contents($fh);
        flock($fh, LOCK_UN);
        fclose($fh);
        if ($content === false)
          return null;
        return $content;
      };
      $reloadRooms = static function () use (&$log, $roomsFile, $readRoomsRaw) {
        $raw = $readRoomsRaw();
        if ($raw === null) {
          $log->warn('events:roomsReloadFailed', ['file' => $roomsFile]);
          return [['rooms' => []], null];
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded) || !isset($decoded['rooms']) || !is_array($decoded['rooms']))
          $decoded = ['rooms' => []];
        return [$decoded, hash('sha256', $raw)];
      };
      $loadRooms = static function (bool $force = false) use (&$roomsCache, &$roomsCacheMtime, &$roomsCacheHash, &$roomsCacheLastLoad, $roomsFile, $readRoomsRaw, $reloadRooms) {
        if ($force) {
          $roomsCache = null;
          $roomsCacheMtime = null;
          $roomsCacheHash = null;
          $roomsCacheLastLoad = 0.0;
        }
        clearstatcache(false, $roomsFile);
        $mtimeRaw = @filemtime($roomsFile);
        $mtime = $mtimeRaw !== false ? $mtimeRaw : null;
        $now = microtime(true);
        if ($roomsCache === null || $roomsCacheMtime === null || $roomsCacheHash === null || $force || $mtime === null || $roomsCacheMtime !== $mtime) {
          [$roomsCache, $roomsCacheHash] = $reloadRooms();
          $roomsCacheMtime = $mtime;
          $roomsCacheLastLoad = $now;
          return $roomsCache;
        }
        if (($now - $roomsCacheLastLoad) >= 0.5) {
          $raw = $readRoomsRaw();
          if ($raw === null) {
            [$roomsCache, $roomsCacheHash] = $reloadRooms();
          } else {
            $hash = hash('sha256', $raw);
            if ($roomsCacheHash !== $hash) {
              $decoded = json_decode($raw, true);
              if (!is_array($decoded) || !isset($decoded['rooms']) || !is_array($decoded['rooms']))
                $decoded = ['rooms' => []];
              $roomsCache = $decoded;
              $roomsCacheHash = $hash;
            }
          }
          $roomsCacheLastLoad = $now;
          $roomsCacheMtime = $mtime;
        }
        return $roomsCache;
      };
      $invalidateRoomsCache = static function () use (&$roomsCache, &$roomsCacheMtime, &$cachedRoomStatus, &$lastRoomStatusCheck) {
        $roomsCache = null;
        $roomsCacheMtime = null;
        $cachedRoomStatus = null;
        $lastRoomStatusCheck = 0.0;
      };
      if ($roomId !== '') {
        $roomsData = $loadRooms(true);
        if (!is_array($roomsData) || !isset($roomsData['rooms']) || !is_array($roomsData['rooms']))
          $roomsData = ['rooms' => []];
        $roomEntry = null;
        foreach ($roomsData['rooms'] as $idx => &$candidate) {
          if (($candidate['id'] ?? '') === $roomId) {
            $roomEntry =& $candidate;
            break;
          }
        }
        unset($candidate);
        if ($roomEntry === null) {
          $log->warn('events:roomNotFound', ['roomId' => $roomId]);
          json_error('部屋が見つかりません', 404);
          return;
        }
        $roomsChanged = ensure_room_security($roomEntry);
        $requiresAuth = isset($roomEntry['password']) && $roomEntry['password'] !== '';
        if ($requiresAuth) {
          $authResult = authenticate_room_member($roomEntry, (string) $playerId, (string) $authToken);
          if (!($authResult['ok'] ?? false)) {
            $log->warn('events:authFailed', [
              'roomId' => $roomId,
              'playerId' => $playerId,
              'reason' => $authResult['reason'] ?? 'unknown',
            ]);
            json_error('認証に失敗しました', 401);
            return;
          }
          if (touch_member($roomEntry, (string) $playerId))
            $roomsChanged = true;
        }
        if ($roomsChanged) {
          write_json($roomsFile, $roomsData);
          $invalidateRoomsCache();
          $roomsData = $loadRooms(true);
          $cachedRoomStatus = $roomsData;
          $lastRoomStatusCheck = microtime(true);
        }
      }
      header('Content-Type: text/event-stream');
      header('Cache-Control: no-cache');
      // HTTP/2 disallows certain hop-by-hop headers (e.g. Connection and
      // Transfer-Encoding) and some servers or proxies may add them
      // automatically, causing browsers to drop the stream with a protocol
      // error. Remove them explicitly to keep the SSE stream alive.
      if (function_exists('header_remove')) {
        header_remove('Connection');
        header_remove('Transfer-Encoding');
      } else {
        header('Connection:');
        header('Transfer-Encoding:');
      }
      // Long-lived SSE connections can exceed the default execution time limit
      // which would silently terminate the stream and halt enemy simulation.
      // Ensure the script can run indefinitely for this request.
      if (function_exists('set_time_limit')) {
        set_time_limit(0);
      }
      // Disable output compression which can interfere with SSE streaming.
      if (function_exists('ini_set')) {
        ini_set('zlib.output_compression', '0');
      }

      $logFile = "$eventsDir/$roomId.log";
      $pos = 0;
      $lastEventId = isset($_GET['lastEventId']) ? (int) $_GET['lastEventId'] : (isset($_SERVER['HTTP_LAST_EVENT_ID']) ? (int) $_SERVER['HTTP_LAST_EVENT_ID'] : null);
      if ($lastEventId !== null && function_exists('hrtime')) {
        $nowId = hrtime(true);
        if ($lastEventId > $nowId) {
          $lastEventId = null; // サーバー再起動でIDが巻き戻った場合に備える
        }
      }
      $lastRooms = 0;
      $f = null;
      $roomStatusPollInterval = 0.5;
      while (true) {
        if (connection_aborted()) {
          break;
        }
        clearstatcache();
        // opportunistic server-side simulation tick (only if enabled)
        try {
          // read roomId status quickly
          if ($roomId) {
            $now = microtime(true);
            if ($cachedRoomStatus === null || ($now - $lastRoomStatusCheck) >= $roomStatusPollInterval) {
              $cachedRoomStatus = $loadRooms();
              $lastRoomStatusCheck = $now;
            }
            if (!is_array($cachedRoomStatus)) {
              $cachedRoomStatus = ['rooms' => []];
            }
            $data0 = $cachedRoomStatus;
            foreach (($data0['rooms'] ?? []) as $r0) {
              if (($r0['id'] ?? '') === $roomId && ($r0['status'] ?? 'room') === 'game' && !empty($r0['simEnemies']) && time() >= (int) ($r0['gameStartAt'] ?? 0)) {
                simulate_enemies($roomsFile, $stateDir, $eventsDir, $roomId);
                break;
              }
            }
          }
        } catch (Throwable $e) {
          // ignore
        }
        if ($roomId && file_exists($logFile)) {
          $size = filesize($logFile);
          if ($size < $pos) {
            $pos = 0;
          }
          if ($size > $pos) {
            $f = fopen($logFile, 'r');
            if ($f === false) {
              $log->warn('events:fopenFailed', ['file' => $logFile]);
            } else {
              fseek($f, $pos);
              while (!feof($f)) {
                $start = ftell($f);
                $line = fgets($f);
                if ($line === false) {
                  break;
                }
                // スパース書き込み中の未完行は送らない（行末の \n が付いていない）
                if ($line !== '' && substr($line, -1) !== "\n") {
                  // 読み取り位置を未完行の先頭に戻し、後で再試行
                  fseek($f, $start, SEEK_SET);
                  break;
                }
                if (trim($line) !== '') {
                  $entry = json_decode($line, true);
                  if (is_array($entry)) {
                    if (isset($entry['data'])) {
                      $id = (int) ($entry['id'] ?? 0);
                      $payload = $entry['data'];
                    } else {
                      // backward compatibility: old logs without id/data wrapper
                      $id = 0;
                      $payload = $entry;
                    }
                    if ($lastEventId === null || $id > $lastEventId) {
                      if ($id) {
                        echo 'id: ' . $id . "\n";
                        $lastEventId = $id;
                      }
                      echo 'data: ' . json_encode($payload, JSON_UNESCAPED_UNICODE) . "\n\n";
                    }
                  }
                }
              }
              $pos = ftell($f);
              fclose($f);
              if (ob_get_level() > 0) {
                ob_flush();
              }
              flush();
            }
          }
        }
        // also send room list every 3s for lobby
        if (time() % 3 === 0 && $lastRooms !== time()) {
          $lastRooms = time();
          $data = $loadRooms();
          if (!is_array($data) || !isset($data['rooms']) || !is_array($data['rooms'])) {
            $data = ['rooms' => []];
          }
          if (cleanup_rooms($data, $eventsDir, $stateDir, $ROOM_TTL_HOURS, $MEMBER_TTL_SEC)) {
            write_json($roomsFile, $data);
            $invalidateRoomsCache();
            $data = $loadRooms(true);
            if (!is_array($data) || !isset($data['rooms']) || !is_array($data['rooms'])) {
              $data = ['rooms' => []];
            }
            if ($roomId !== '') {
              $cachedRoomStatus = $data;
              $lastRoomStatusCheck = microtime(true);
            }
          }
          foreach ($data['rooms'] as &$room) {
            $room = room_public_payload($room);
          }
          unset($room);
          echo 'data: ' . json_encode(['type' => 'rooms', 'rooms' => $data['rooms']], JSON_UNESCAPED_UNICODE) . "\n\n";
          if (ob_get_level() > 0) {
            ob_flush();
          }
          flush();
        }
        usleep(66666); // ~0.067s
      }
      if (is_resource($f)) {
        fclose($f);
      }
      return;

    default:
      http_response_code(404);
      echo 'Not Found';
  }
} catch (Throwable $e) {
  vlg_log_uncaught_exception($e);
}
