# Avanza — gestor de tareas para empleados

Aplicación web multiusuario, adaptable a teléfonos y computadoras. Cualquier empleado puede crear y asignar una tarea; solamente el empleado asignado puede cambiar su avance entre 0%, 25%, 50%, 75% y Finalizada.

Una vez publicada mediante HTTPS, puede instalarse en la pantalla principal del teléfono con su propio icono, como una aplicación (PWA).

Todos los usuarios pueden consultar la tabla general de tareas, ordenarla y filtrarla por columnas. Las tareas requieren una fecha de terminación, pueden ser editadas por su creador y deben ser confirmadas como leídas por el empleado asignado. Los estados disponibles son 0%, 25%, 50%, 75% y Finalizada.

Los títulos admiten hasta 50 caracteres. La descripción conserva un historial acumulativo de anotaciones que pueden agregar el creador y el empleado asignado, sin sobrescribir lo anterior. Las filas finalizadas aparecen tachadas y se eliminan automáticamente 15 días después de su finalización; si se reabre una tarea, el plazo se cancela.

## Notificaciones móviles

Cada empleado debe pulsar **Activar notificaciones** una vez desde su propio teléfono y aceptar el permiso del navegador. Las claves Web Push se generan automáticamente y se guardan en `data/database.json`; por ello, el disco persistente debe estar montado correctamente en producción. En iPhone, la aplicación debe agregarse primero a la pantalla de inicio.

El botón **Instalar aplicación** incluye un asistente para seleccionar iPhone, Android o computadora y muestra las instrucciones apropiadas para cada dispositivo.

## Puesta en marcha

Requiere Node.js 18 o posterior.

```powershell
npm start
```

Luego abre `http://localhost:3000`.

- Usuario inicial: `admin`
- Contraseña inicial: `Admin123!`

Para definir otra contraseña antes del primer inicio:

```powershell
$env:ADMIN_PASSWORD="UnaClaveSegura"
npm start
```

El administrador crea las cuentas de los empleados desde la sección **Empleados**.

## Datos y multiusuario

Los datos se almacenan en `data/database.json`, que se crea automáticamente. Las escrituras se serializan y se reemplaza el archivo completo de forma atómica para evitar archivos parcialmente escritos ante solicitudes simultáneas.

Para acceso desde otros equipos en la misma red, permite el puerto 3000 en el firewall y abre `http://IP-DE-LA-PC-SERVIDOR:3000`. Para uso por Internet se recomienda desplegar detrás de HTTPS y configurar `ADMIN_PASSWORD` antes del primer arranque.

Haz copias de seguridad periódicas de la carpeta `data`. Las contraseñas se guardan mediante `scrypt` con sal individual; no se almacenan en texto plano.

## Chat privado

Avanza incluye conversaciones privadas entre usuarios registrados. El chat funciona en tiempo real mediante eventos del servidor y conserva los mensajes en la misma base persistente de la aplicación. Permite mensajes de texto, imágenes y documentos de hasta 5 MB por archivo, con un máximo de tres archivos y 8 MB por mensaje.

Cada mensaje registra fecha y hora y mantiene estados independientes de enviado, entregado y leído. La interfaz presenta conversaciones, último mensaje, mensajes pendientes, buscador de integrantes, indicador de escritura y notificaciones push.

El modelo de datos está separado en las siguientes colecciones:

- `conversations`: conversación directa o grupal y sus opciones generales.
- `conversationParticipants`: integrantes, rol, silenciamiento y última lectura.
- `messages`: texto, tipo, referencias para respuesta y reenvío, y eliminación futura.
- `attachments`: metadatos y contenido de imágenes, documentos o futuras notas de voz.
- `messageReceipts`: entrega y lectura individual por participante.
- `calls`: colección reservada para futuras llamadas.

Esta separación permite añadir posteriormente grupos, respuestas, reenvíos, eliminación, fijado, búsqueda, notas de voz y llamadas sin mezclar los mensajes con las tareas de empleados o maquinarias.
