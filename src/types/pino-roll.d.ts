declare module 'pino-roll' {
  import type { WritableOptions } from 'node:stream';

  export interface RollOptions extends WritableOptions {
    file: string;
    frequency?: 'daily' | 'hourly' | number;
    dateFormat?: string;
    size?: string | number;
    mkdir?: boolean;
    extension?: string;
    limit?: { count?: number; resolution?: 'daily' | 'hourly' };
    symlink?: boolean;
  }

  function roll(opts: RollOptions): Promise<NodeJS.WritableStream>;
  export default roll;
}
