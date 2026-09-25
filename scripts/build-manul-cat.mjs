// Original vector pixel art: right-facing cats, drawn without external assets.
// node scripts/build-manul-cat.mjs — no dependencies.
import { writeFileSync } from 'node:fs'
const W = 72, H = 32, N = 12
const ink = '#514640'
const r = (x,y,w,h,c) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`
const p = (d,c) => `<path d="${d}" fill="${c}"/>`
const group = (x,y,art) => `<g transform="translate(${x} ${y})">${art}</g>`
const phase = [0,0,1,2,2,1,0,0,-1,-2,-2,-1]
function head(fur, light, patch) {
  return p('M42 8h3V6h5v2h7V7h5v4h2v3h3v8h-3v3H47v-2h-4v-3h-2V11h1z',ink)
    + p('M43 11h3V8h3v3h9V9h3v4h2v3h3v5h-3v3H48v-2h-4v-3h-2v-6h1z',fur)
    + r(45,9,3,2,patch)+r(59,10,2,2,patch)
    + p('M44 17h7v2h7v-1h7v3h-3v2H49v-2h-5z',light)
    + r(52,14,5,1,ink)+r(53,15,2,1,'#caba76')+r(54,15,1,1,ink)
    + r(64,16,3,2,ink)+r(60,20,4,1,ink)
    + r(46,14,2,2,patch)+r(48,17,2,2,patch)+r(49,20,2,2,patch)
}
function manul(i) {
  const step = phase[i], bob = i===3||i===4||i===9||i===10 ? 1:0
  const fur='#b9b2a3', light='#ded8c8', patch='#817d76'
  let art = p('M22 21H8v-2H4v-7h4v4h5v1h9z',ink)
    + p('M21 20H9v-2H6v-4h1v3h6v1h8z',fur)
    + r(9,17,2,3,patch)+r(14,18,2,3,patch)
  art += [[23,step],[31,-step],[47,-step],[55,step]].map(([x,s])=>r(x+Math.sign(s),24,7,6-(Math.abs(s)===2?1:0),ink)+r(x+1+Math.sign(s),24,5,5-(Math.abs(s)===2?1:0),patch)).join('')
  art += p('M22 5h20v2h7v4h4v5h2v7h-3v4H22v-2h-5V13h2V8h3z',ink)
    + p('M23 6h18v2h7v4h3v5h2v5h-3v4H23v-2h-5V14h2V9h3z',fur)
    + p('M20 17h4v3h4v2h15v-2h7v4h-3v1H24v-2h-4z',light)
    + r(25,7,3,2,patch)+r(33,8,4,2,patch)+r(21,12,2,3,patch)+r(28,13,2,2,patch)+r(37,12,3,2,patch)
    + r(22,19,2,2,patch)+r(32,18,2,2,patch)+r(40,17,2,2,patch)
    + head(fur,light,patch)
  return r(14,31,49,1,'#283437')+group(0,bob,art)
}
const frames=Array.from({length:N},(_,i)=>group(i*W,0,manul(i))).join('')
writeFileSync(new URL('../web/public/manul-cat.svg',import.meta.url),`<svg xmlns="http://www.w3.org/2000/svg" width="${W*N}" height="${H}" viewBox="0 0 ${W*N} ${H}" shape-rendering="crispEdges"><title>ずしずしマヌルネコ</title>${frames}</svg>\n`)
