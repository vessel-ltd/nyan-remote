// Development-only gallery renders the actual app component.
import { render } from 'preact'
import { useState } from 'preact/hooks'
import { Nyan } from './src/ui/Nyan.tsx'
import { CAT_CHOICES } from './src/ui/catPreference.ts'
import './src/styles.css'
import '../docs/cat-preview.css'
function Preview() {
  const [running, setRunning] = useState(true)
  return <main>
    <small>ADOPTED CATS / 07</small><h1>ねこの試着室</h1>
    <p>右を向いて、いっしょに作業。<br />ねこをタップすると、相棒を変更できます。</p>
    <section class="try"><div class="sample"><Nyan running={running} /><span>{running ? '実行中' : '入力待ち'}</span></div>
      <button onClick={() => setRunning(!running)}>{running ? '動きを止める' : '動かす'}</button>
    </section>
    <div class="gallery">{CAT_CHOICES.map(cat => <section class="swatch" data-cat={cat.id} key={cat.id}>
      <div class="large"><span class={running ? 'nyan nyanrun' : 'nyan'} aria-hidden="true" /></div>
      <h2>{cat.label}</h2><p>{cat.id === 'manul-cat' ? 'もふもふ、ずしずし。' : cat.id === 'mochi-cat' ? 'もちっと縮んで、びよん。' : cat.id === 'fluffy-cat' ? 'ふさふさしっぽで、ぴょん。' : 'ぐっと伸びて、たったか。'}</p>
    </section>)}</div>
    <p>選択はこのブラウザに保存されます。端末の「動きを減らす」設定では静止します。</p>
  </main>
}
render(<Preview />, document.getElementById('preview')!)
