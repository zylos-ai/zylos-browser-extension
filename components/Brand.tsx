import logo from '../assets/brand/logo.png';

/** Octopus from the original logo, used in the welcome state and assistant avatar. */
export function Brand({ large = false }: { large?: boolean }) {
  return (
    <span className={`brand-mark brand-mascot${large ? ' brand-large' : ''}`} aria-hidden="true">
      <img src={logo} alt="" draggable={false} />
    </span>
  );
}
