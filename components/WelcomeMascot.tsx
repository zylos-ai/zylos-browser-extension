import { useEffect, useId, useState } from 'react';

/** The two curled arms are the animated paths themselves, joined to the head at fixed roots. */
export function WelcomeMascot() {
  const clipId = useId();
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);

  return (
    <div className="welcome-scene" aria-hidden="true" data-paused={!visible || undefined}>
      <svg viewBox="0 0 240 152" fill="none" focusable="false">
        <defs>
          <clipPath id={clipId}>
            <rect x="70" y="114" width="88" height="23" rx="3" />
          </clipPath>
        </defs>

        <g className="welcome-browser">
          <rect className="welcome-browser-window" x="58" y="63" width="124" height="82" rx="10" />
          <path className="welcome-browser-divider" d="M59 81H181" />
          <g className="welcome-browser-dots">
            <circle cx="69" cy="72" r="2" />
            <circle cx="76" cy="72" r="2" />
            <circle cx="83" cy="72" r="2" />
          </g>
          <rect className="welcome-browser-address" x="96" y="69" width="61" height="6" rx="3" />
          <rect className="welcome-browser-heading" x="70" y="89" width="57" height="4" rx="2" />
          <rect className="welcome-browser-button" x="70" y="98" width="47" height="10" rx="5" />
          <path className="welcome-browser-button-label" d="M77 103H98" />
          <path className="welcome-browser-check" d="m103 102 2 2 4-4" />
          <g clipPath={`url(#${clipId})`}>
            <g className="welcome-browser-list">
              {[116, 129, 142, 155].map((y) => (
                <g key={y}>
                  <rect className="welcome-browser-tile" x="70" y={y} width="9" height="9" rx="3" />
                  <path className="welcome-browser-line" d={`M85 ${y + 2}h65M85 ${y + 7}h40`} />
                </g>
              ))}
            </g>
          </g>
          <path className="welcome-browser-track" d="M170 91V135" />
          <path className="welcome-browser-scroll" d="M170 98V109" />
        </g>

        <g className="welcome-mascot" transform="translate(76 -10)">
          <path
            className="welcome-mascot-head"
            d="M33 53C29 49 26 43 26 36C26 26 34 18.5 44 18.5C54 18.5 62 26 62 36C62 43 59 49 55 53"
          />
          <g className="welcome-mascot-eyes">
            <path d="M33.5 33.5L41.25 36.5C42.75 44.5 30 46.5 31.5 37.5Z" />
            <path d="M54.5 33.5L46.75 36.5C45.25 44.5 58 46.5 56.5 37.5Z" />
          </g>
          <path
            className="welcome-arm welcome-arm-click"
            d="M33 53C39 59 37 68 29 70C20 73 12.5 66.5 12.5 59C12.5 51 18 47 25 47"
          />
          <path
            className="welcome-arm welcome-arm-scroll"
            d="M55 53C49 59 51 68 59 70C68 73 75.5 66.5 75.5 59C75.5 51 70 47 63 47"
          />
        </g>
        <circle className="welcome-click-ring" cx="107" cy="103" r="8" />
      </svg>
    </div>
  );
}
