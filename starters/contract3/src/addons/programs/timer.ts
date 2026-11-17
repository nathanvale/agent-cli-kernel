// Platform: A runtime timer holds at most 2,147,483,647 ms and fires a longer delay
// after 1 ms.
const timerLimit = 2_147_483_647;

export function afterDelay(milliseconds: number, fire: () => void): () => void {
  const due = performance.now() + milliseconds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (delay: number) => {
    const stepped = delay > timerLimit;
    timer = setTimeout(
      () => {
        const left = due - performance.now();
        if (stepped && left > 0) arm(left);
        else fire();
      },
      Math.min(delay, timerLimit),
    );
  };
  arm(Math.max(0, milliseconds));
  return () => clearTimeout(timer);
}
