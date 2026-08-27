/**
 * The window backdrop.
 *
 * A flat fill in the default appearance - the spans are inert and only the
 * opt-in glass appearance gives them a size, a colour and a blur.
 */
export function Ambient() {
  return (
    <div className="ambient" aria-hidden>
      <span />
      <span />
      <span />
    </div>
  );
}
