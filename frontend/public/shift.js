// Ajusta o tempo de todas as legendas de um arquivo .vtt.
//
// Uso (na pasta frontend/public):
//   node shift.js -3        -> ADIANTA a legenda em 3 segundos (corrige legenda atrasada)
//   node shift.js 2.5       -> ATRASA a legenda em 2,5 segundos (corrige legenda adiantada)
//
// Lê "legenda-pt.vtt" e gera "legenda-pt-shifted.vtt" ao lado dele.
// O original nunca é alterado: rode sempre a partir dele, sem somar ajustes.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const input = path.join(dir, 'legenda-pt.vtt')
const output = path.join(dir, 'legenda-pt-shifted.vtt')

const offset = parseFloat(process.argv[2])
if (Number.isNaN(offset)) {
  console.error('Informe o ajuste em segundos. Ex.: node shift.js -3')
  process.exit(1)
}
if (!fs.existsSync(input)) {
  console.error(`Arquivo não encontrado: ${input}`)
  process.exit(1)
}

// "01:41.852" ou "01:02:09.309" -> segundos
const toSeconds = (t) => {
  const p = t.split(':').map(parseFloat)
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]
}

// segundos -> "HH:MM:SS.mmm"
const format = (s) => {
  s = Math.max(0, s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toFixed(3).padStart(6, '0')
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`
}

let count = 0
const text = fs
  .readFileSync(input, 'utf8')
  .replace(/(\d+(?::\d+){1,2}\.\d+)\s+-->\s+(\d+(?::\d+){1,2}\.\d+)/g, (_, a, b) => {
    count++
    return `${format(toSeconds(a) + offset)} --> ${format(toSeconds(b) + offset)}`
  })

fs.writeFileSync(output, text)
console.log(`${count} legendas ajustadas em ${offset}s -> ${output}`)
