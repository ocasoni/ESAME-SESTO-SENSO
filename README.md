# L'eco di un respiro

Il progetto nasce dalla volontà di indagare il concetto di sesto senso e di chiedersi se questo possa essere immaginato come un’interfaccia, un sistema capace di rendere percepibile ciò che normalmente resta nascosto, invisibile o difficile da tradurre.

<img src="assets/1.gif" width="100%">

Link per provarlo: https://ocasoni.github.io/ESAME-SESTO-SENSO/

A partire da questa domanda, il progetto esplora il respiro come segnale intimo e invisibile, trasformandolo in una presenza visiva nello spazio digitale.

In questo modo, il respiro diventa una traccia visibile e temporanea, una possibile interfaccia sensibile tra corpo, suono e spazio digitale.

# Il progetto

Il progetto genera scie particellari 3D a partire dal suono del respiro registrato dall’utente. Il sistema è diviso in tre fasi principali:

- **Fase 1:** registrazione e invio dell’audio
- **Fase 2:** analisi del suono
- **Fase 3:** generazione delle scie

L’obiettivo non è analizzare il respiro in modo medico, ma trasformare ritmo, intensità e qualità sonora dell’audio in una forma visiva nello spazio 3D, in modo da poter, metaforicamente, fissare la presenza di una persona nello spazio e nel tempo.

---

# Come funziona

## Fase 1: registrazione e invio dell’audio

Il sistema usa il telefono dell’utente come microfono remoto. Il computer mostra la visualizzazione Three.js, mentre il telefono registra il respiro e invia l’audio al backend.

Il flusso è:

```txt
Telefono utente
        ↓
Scannerizza QR code presente sul desktop
        ↓
GitHub Pages / sito microfono
        ↓
Render / backend
        ↓
PC con schermo desktop
```
<img src="assets/2.gif" width="100%">

Sul desktop viene generato un QR code. Quando l’utente lo scannerizza, apre sul telefono una pagina web ospitata su GitHub Pages. Questa pagina serve per registrare il suono del respiro.

Dopo la registrazione, l’audio viene inviato al backend ospitato su Render. Il computer, intanto, controlla periodicamente il backend per verificare se sono arrivati nuovi file audio.

`startUploadPolling()` viene usato per controllare periodicamente il backend. Quando arriva una nuova registrazione, viene chiamata la funzione `handleNewPhoneUpload`, il computer scarica l’audio tramite `fetchUploadAudio`, poi lo analizza con `extractBreathFramesFromArrayBuffer` e crea una nuova scia con `createTrail`.

Ogni registrazione diventa quindi una scia indipendente, che conserva il ritmo e le caratteristiche sonore del respiro registrato.

---

## Fase 2: analisi del suono

Dopo essere stato scaricato, l’audio viene decodificato e analizzato con la Web Audio API.

La pipeline è:

```txt
Audio caricato
        ↓
AudioContext
        ↓
AnalyserNode
        ↓
Waveform + FFT
        ↓
Parametri audio
        ↓
Frame audio
```

Il codice usa un `AnalyserNode` per ottenere due tipi di dati:


| Dato            | Funzione                  | Utilizzo                                  |
| --------------- | ------------------------- | ----------------------------------------- |
| `waveformData`  | `getByteTimeDomainData()` | Calcola l’intensità generale del suono    |
| `frequencyData` | `getByteFrequencyData()`  | Analizza la distribuzione delle frequenze |


### Valori estratti dall’audio


| Valore              | Come viene calcolato                   | A cosa serve                                     |
| ------------------- | -------------------------------------- | ------------------------------------------------ |
| `level`             | Deriva dall’energia RMS della waveform | Indica l’intensità generale del respiro          |
| `noiseFloor`        | Soglia minima sottratta al segnale     | Riduce il rumore di fondo                        |
| `rawLevel`          | `cleanedRms * breathSensitivity`       | Amplifica il respiro registrato                  |
| `level` non lineare | `Math.pow(rawLevel, 0.55)`             | Rende visibili anche respiri deboli              |
| `lowBand`           | Energia nelle frequenze basse          | Dà peso e stabilità alla scia                    |
| `midBand`           | Energia nelle frequenze medie          | Aggiunge corpo e profondità                      |
| `highBand`          | Energia nelle frequenze alte           | Aggiunge aria, frizione e turbolenza             |
| `spectralCentroid`  | Centro di massa dello spettro          | Indica se il suono è più morbido o più fricativo |


### Frame audio

Ogni frame audio rappresenta lo stato del suono in un preciso momento della registrazione.

Ogni frame contiene:


| Valore del frame   |
| ------------------ |
| `level`            |
| `lowBand`          |
| `midBand`          |
| `highBand`         |
| `spectralCentroid` |


Tutti i frame vengono salvati dentro la scia in `trail.loopFrames`.

Durante l’animazione, questi frame vengono riletti in loop. Il codice interpola tra un frame e il successivo per ottenere un movimento più fluido. In questo modo la scia conserva il ritmo dell’audio registrato, ma evita scatti improvvisi tra un frame e l’altro.

### Valori derivati dal respiro

Dopo l’analisi audio, il codice calcola alcuni valori aggiuntivi che servono a trasformare il suono in movimento.


| Valore                   | Significato                                  | Uso visivo                                     |
| ------------------------ | -------------------------------------------- | ---------------------------------------------- |
| `breathEnvelope`         | Versione smussata di `level`                 | Disegna l’andamento generale del respiro       |
| `previousBreathEnvelope` | Envelope del frame precedente                | Serve per confrontare il cambiamento           |
| `breathDelta`            | Differenza tra envelope attuale e precedente | Capisce se il respiro cresce o diminuisce      |
| `breathPhase`            | Fase stimata del respiro                     | Determina direzione e comportamento della scia |
| `breathPhaseAmount`      | Intensità del cambiamento                    | Controlla la forza della reazione visiva       |
| `breathCyclePhase`       | Fase ciclica interna                         | Aggiunge curvatura e movimento morbido         |


La logica della fase è:


| Condizione              | Fase     |
| ----------------------- | -------- |
| Energia molto bassa     | `pause`  |
| Envelope in crescita    | `inhale` |
| Envelope in diminuzione | `exhale` |
| Energia stabile         | `hold`   |


Le soglie principali sono:


| Soglia             | Significato                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `inhaleThreshold`  | Valore minimo positivo per riconoscere una crescita del respiro    |
| `exhaleThreshold`  | Valore minimo negativo per riconoscere una diminuzione del respiro |
| `silenceThreshold` | Valore sotto cui il segnale viene considerato pausa o silenzio     |


---

## Fase 3: generazione delle scie

La terza fase traduce i dati ottenuti dall’analisi audio in una scia particellare 3D.

La pipeline visiva è:

```txt
Frame audio
        ↓
Breath envelope + breath phase
        ↓
Movimento della scia
        ↓
Spawn particelle
        ↓
Forma, colore, luminosità e dissolvenza
        ↓
Scia 3D finale
```

Quando arriva un nuovo audio, viene creata una nuova scia con `createTrail`. Ogni scia contiene la propria posizione, velocità, direzione, colore, frame audio e stato del respiro.

<img src="assets/3.gif" width="100%">

### Mappatura audio-visiva


| Valore audio / visivo                     | Effetto sulla scia                                |
| ----------------------------------------- | ------------------------------------------------- |
| `breathEnvelope`                          | Controlla intensità, velocità e densità generale  |
| `breathPhase`                             | Determina il comportamento principale della scia  |
| `breathPhaseAmount`                       | Aumenta o riduce la forza della reazione          |
| `lowBand`                                 | Rende la scia più pesante e stabile               |
| `midBand`                                 | Aggiunge corpo e profondità alla forma            |
| `highBand`                                | Aggiunge aria, brillantezza e turbolenza          |
| `spectralCentroid`                        | Aggiunge torsione e variazione laterale           |
| `cymaticLow`, `cymaticMid`, `cymaticHigh` | Controllano la struttura interna delle particelle |
| `colorBrightness`                         | Controlla la luminosità finale                    |
| `turbAmplitude`                           | Controlla la vibrazione e la turbolenza           |


### Movimento in base alla fase


| Fase     | Comportamento visivo               |
| -------- | ---------------------------------- |
| `inhale` | La scia sale, si apre e accelera   |
| `exhale` | La scia scende, rientra e rallenta |
| `pause`  | La scia quasi si ferma             |
| `hold`   | La scia rimane sospesa             |


La direzione della scia viene calcolata a partire dalla fase del respiro e poi smussata, così il movimento resta fluido e meno meccanico.

### Particelle e forma interna

Il numero di particelle dipende dall’intensità del respiro: un respiro più intenso genera una scia più densa, mentre un respiro più debole genera una scia più rarefatta.

Le particelle vengono poi deformate da una struttura interna di tipo cimatico-sonoro, controllata dalle bande di frequenza.


| Banda      | Effetto sulla forma               |
| ---------- | --------------------------------- |
| `lowBand`  | Forme più ampie, lente e pesanti  |
| `midBand`  | Struttura intermedia e profondità |
| `highBand` | Dettagli, vibrazione e aria       |


In sintesi:


| Livello             | Controllato da                   | Risultato                        |
| ------------------- | -------------------------------- | -------------------------------- |
| Traiettoria globale | `breathEnvelope`, `breathPhase`  | Movimento nello spazio 3D        |
| Forma interna       | `lowBand`, `midBand`, `highBand` | Struttura particellare           |
| Torsione            | `spectralCentroid`, `highBand`   | Variazione laterale e profondità |
| Densità             | `breathEnvelope`                 | Quantità di particelle           |
| Luminosità          | `highBand`, `lowBand`, `midBand` | Brillantezza della scia          |
| Turbolenza          | `breathEnvelope`, `highBand`     | Vibrazione controllata           |


### Dissolvenza

Le particelle hanno una vita e una dissolvenza. Quando una scia viene sostituita o rimossa, non sparisce subito, ma viene aggiunta a `fadingTrails`.

La dissolvenza abbassa progressivamente i valori di `life` e `reveal`, facendo scomparire la scia in modo graduale.

---

## Riassunto

Il progetto funziona attraverso tre passaggi:


| Fase   | Descrizione                                                           |
| ------ | --------------------------------------------------------------------- |
| Fase 1 | Il telefono registra il respiro e invia l’audio al backend            |
| Fase 2 | Il computer scarica l’audio e lo trasforma in parametri sonori        |
| Fase 3 | I parametri sonori generano movimento, forma e dissolvenza delle scie |


La logica principale è:


| Audio                 | Visuale                                 |
| --------------------- | --------------------------------------- |
| Intensità del respiro | Movimento e densità                     |
| Andamento del respiro | Inspirazione, espirazione, pausa e hold |
| Frequenze basse       | Peso e stabilità                        |
| Frequenze medie       | Corpo e profondità                      |
| Frequenze alte        | Aria, turbolenza e luminosità           |
| Centroide spettrale   | Torsione e qualità spaziale             |


Il risultato è una scia 3D che non reagisce solo al volume, ma cerca di conservare ritmo, energia e texture sonora del respiro registrato.

## Contatti

**Autrice:** Ottavia Casoni <br>
**Email:** ottaviacasoni@gmail.com <br>
**Instagram:** @ottaviacasoni
