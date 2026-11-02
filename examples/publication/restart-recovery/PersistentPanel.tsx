import { useState } from 'react';

export default function PersistentPanel() {
  const [view, setView] = useState(() => localStorage.getItem('view') ?? 'overview');
  function choose(next: string) {
    localStorage.setItem('view', next);
    setView(next);
  }
  return (
    <section style={{ padding: 16 }}>
      <h2>Persistent project panel</h2>
      <p>Selected view: <strong>{view}</strong></p>
      <button type="button" onClick={() => choose('overview')}>Overview</button>{' '}
      <button type="button" onClick={() => choose('evidence')}>Evidence</button>
    </section>
  );
}
