type Level = 'silent' | 'error' | 'info' | 'debug';

const ORDER: Record<Level, number> = { silent: 0, error: 1, info: 2, debug: 3 };

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (['silent', 'error', 'info', 'debug'] as Level[]).includes(raw as Level)
    ? (raw as Level)
    : 'info';
}

function emit(level: Exclude<Level, 'silent'>, message: string, meta?: unknown): void {
  if (ORDER[level] > ORDER[currentLevel()]) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  const stream = level === 'error' ? console.error : console.log;
  if (meta === undefined) stream(line);
  else stream(line, typeof meta === 'string' ? meta : JSON.stringify(meta));
}

export const logger = {
  error: (message: string, meta?: unknown) => emit('error', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
};
