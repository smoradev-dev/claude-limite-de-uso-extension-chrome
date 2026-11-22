# Claude Límite de Uso: extensión de Chrome para ver cuánto uso te queda en Claude

**Extensión gratuita y de código abierto en español** para Chrome, Opera GX, Edge y Brave que muestra **cuánto te queda del límite de uso de Claude** (claude.ai): el porcentaje restante de la sesión de 5 horas y del límite semanal, la **hora exacta en que se reinicia** y **cuántos mensajes más puedes enviar** antes de llegar al tope.

¿Te salió "Has alcanzado el límite de mensajes" en Claude sin aviso? Con esta extensión ves el contador de uso de Claude en tiempo real, recibes una alerta antes de quedarte sin mensajes y una notificación cuando el límite se reinicia. Funciona con Claude Free, Pro y Max.

> Proyecto no oficial, sin relación con Anthropic. Todo se procesa en tu navegador: no envía datos a ningún servidor.

**Palabras clave:** límite de uso de Claude, cuánto me queda en Claude, contador de mensajes Claude, reinicio del límite de Claude, uso semanal Claude, extensión Claude en español, Claude usage tracker.


## Instalar o actualizar
1. Descomprime la carpeta `claude-uso-ext`.
2. Abre `chrome://extensions` (o `opera://extensions`) y activa **Modo de desarrollador**.
3. **Cargar descomprimida** y elige la carpeta que contiene `manifest.json` (si ya la tenías, pulsa recargar en la extensión).
   Requiere Chrome 111 o posterior (Opera GX actual también sirve).
4. Abre claude.ai, recarga con Ctrl+Shift+R y envía un mensaje.

## Qué hace
- Barra en claude.ai con todas las ventanas de uso (sesión 5 h y semanal), coloreadas por nivel.
- Cuenta regresiva en horas, minutos y segundos hasta el reinicio.
- Estimación de cuántos mensajes más te caben (promedio del cambio de % de tus últimos 12 mensajes, contando los que costaron 0 %).
- Aviso en la página cuando queda menos del umbral (20 % por defecto).
- Notificación del sistema cuando se reinicia la sesión, si te quedaste con poco (botón "Probar notificación" en el popup).
- Detector de cambio de formato: avisa si 3 mensajes seguidos no traen datos válidos.
- Costo por chat: cuánto gasta cada mensaje del chat abierto; sugiere abrir uno nuevo si ya cuesta el doble o más que tus chats nuevos.
- Aviso de "no te alcanza": si te queda menos que el costo reciente de un mensaje, lo dice antes de que lo envíes.
- Ritmo semanal: compara el % usado con el % de la semana transcurrido y proyecta si te alcanza hasta el reinicio.
- Historial de 30 días: gráfica de 24 h y consumo por hora del día (en el popup).
- Barra arrastrable; "–" la convierte en círculo; clic en el círculo la abre.
- Diagnóstico: cómo se interpretó cada campo, el JSON crudo y la última respuesta con error (p. ej. al llegar al límite).

Todo se guarda en tu navegador (chrome.storage.local); no se envía nada a ningún servidor.

Privacidad: el historial guarda, por cada mensaje, la hora, los porcentajes y el id del chat (no su contenido).
Se queda en tu navegador; "Borrar historial" en el popup lo elimina.

## Pruebas
La lógica de cálculo (`shared.js`) se puede probar sin navegador:

```
node tests/shared.test.js
```

## Cambios en 0.7.0 (rediseño de la barra)
- Una sola métrica en toda la barra: "% restante". Arriba va la cifra grande de la ventana más ajustada, con su barra, la hora de renovación y cuántos mensajes te alcanzan. El detalle del costo por mensaje queda en el tooltip ⓘ.
- La semanal (y las ventanas por modelo) van en un bloque aparte. La barra semanal tiene una muesca que marca dónde deberías ir con un ritmo parejo, y una etiqueta "Buen ritmo" / "Ritmo alto".
- Los estados de la API se traducen (`within_limit` → "Dentro del límite").
- Sin precisión falsa: la cuenta regresiva y el "actualizado hace…" ya no muestran segundos salvo cuando falta poco. Si el dato es viejo, la cifra se atenúa y se indica que envíes un mensaje para refrescar.
- La gráfica de 24 h ahora es escalonada y muestra el % restante en la sesión: sube a 100 % justo en cada reinicio (marcado), con horas en el eje.
- Diagnóstico, Copiar JSON y el contador de mensajes de hoy pasan a un menú ⋯ (visible con los detalles abiertos). El naranja queda solo para avisos.

## Cambios en 0.6.0
- Las ventanas por modelo (p. ej. `7d_opus`) ya no se llaman igual que la semanal general, y si dos ventanas coinciden en nombre se distinguen por su ruta: antes sus datos se mezclaban en el historial.
- El costo típico por mensaje cuenta también los mensajes que costaron 0 % (el % llega entero). Antes salía inflado y la estimación de mensajes restantes quedaba corta.
- Las horas de reinicio con unos segundos de diferencia se tratan como la misma ventana (tolerancia de 2 min). Antes eso podía dejar sin estimaciones y repetir avisos.
- La escala de `utilization` (fracción o porcentaje) se decide una vez por aviso, no valor por valor.
- Se leen también las respuestas con error (p. ej. 429 al llegar al límite); si traen datos de uso se aprovechan.
- La duración de la ventana se reconoce también con claves tipo `five_hour` / `seven_day`, así el ritmo semanal funciona con más formatos.
- Menos trabajo: solo se guarda y redibuja cuando algo cambia, y el stream ya no hace `JSON.parse` de cada trozo de texto.
- La barra reaparece en 1 s si claude.ai la borra al recargar su interfaz; "enviados hoy" se reinicia a medianoche aunque no envíes nada.
