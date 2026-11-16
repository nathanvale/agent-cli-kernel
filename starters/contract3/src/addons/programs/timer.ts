// Finding 1 (Nathan, 16 November 2026): every accepted program duration is
// honoured, with no cap. A runtime timer holds at most 2,147,483,647 ms and
// fires a longer delay after 1 ms. A longer wait is armed in steps of at most
// that limit and re-measured on the monotonic clock after each step, so it
// fires neither early nor a step late. A wait within the limit arms once,
// with its exact delay. The kernel keeps its own copy for the deadline; an
// add-on imports only the kernel's public index (CMD-17), which does not offer
// this helper. Both copies are held to one boundary table by the tests.
const timerLimit = 2_147_483_647;

// Calls `fire` once after `milliseconds`; the result cancels it.
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
