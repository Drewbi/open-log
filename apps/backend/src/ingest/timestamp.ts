export function dateFromRotatedFilename(fileName: string): string | null {
  const m = fileName.match(/^(\d{4}-\d{2}-\d{2})-\d+\.log(\.gz)?$/);
  return m ? m[1] : null;
}

function addDays(dateStr: string, days: number): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Minecraft's latest.log only prints HH:mm:ss with no date. This tracks the
 * current date for a single file and rolls forward when the clock goes
 * backwards (midnight rollover). tzOffsetHours is a fixed offset applied to
 * treat the log's local wall-clock time as SERVER_TZ before storing as UTC.
 */
export class DayClock {
  private currentDate: string;
  private lastHms: number | null = null;
  private lastMs: number;

  constructor(seedDate: string, private tzOffsetHours = 0) {
    this.currentDate = seedDate;
    this.lastMs = Date.parse(`${seedDate}T00:00:00Z`);
  }

  resolve(h: number, m: number, s: number): number {
    const hms = h * 3600 + m * 60 + s;
    if (this.lastHms !== null && hms < this.lastHms - 5) {
      this.currentDate = addDays(this.currentDate, 1);
    }
    this.lastHms = hms;
    const [y, mo, d] = this.currentDate.split("-").map(Number);
    const localMs = Date.UTC(y, mo - 1, d, h, m, s);
    const utcMs = localMs - this.tzOffsetHours * 3600_000;
    this.lastMs = utcMs;
    return utcMs;
  }

  lastResolvedMs(): number {
    return this.lastMs;
  }
}
