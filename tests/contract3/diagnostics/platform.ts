const reasons: Readonly<Record<string, string>> = {
  "D09.no-space-volume":
    "no unprivileged size-limited volume: hdiutil is Darwin only, and loop or tmpfs mounts need root",
};

export function unprovedOn(platform: string): readonly string[] {
  return platform === "darwin" ? [] : ["D09.no-space-volume"];
}

export function unprovedHere(id: string): string | undefined {
  return unprovedOn(process.platform).includes(id) ? reasons[id] : undefined;
}

export function reportUnproved(id: string, reason: string): void {
  process.stderr.write(`UNPROVED ${id} on ${process.platform}: ${reason}\n`);
}
