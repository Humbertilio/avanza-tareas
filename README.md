# Avanza — gestor de tareas para empleados

Aplicación web multiusuario, adaptable a teléfonos y computadoras. Cualquier empleado puede crear y asignar una tarea; solamente el empleado asignado puede cambiar su avance entre 0%, 25%, 50%, 75% y Finalizada.

Avanza incluye también el módulo de inventario anteriormente identificado como Nexo. Utiliza el mismo inicio de sesión y la misma base de datos: administradores controlan todas las operaciones, empleados administran entradas y salidas sin borrar, y clientes consultan artículos activos y envían solicitudes de compra.

El inventario admite los campos Material, Calibre, Ancho, Peso, Gramaje, Ubicación, ID opcional, Observación y Destino. También permite importar libros Excel, evita repetir una misma hoja, conserva el historial de movimientos y muestra la información en una cuadrícula compacta con filtros y encabezados fijos.

Una vez publicada mediante HTTPS, puede instalarse en la pantalla principal del teléfono con su propio icono, como una aplicación (PWA).

Todos los usuarios pueden consultar la tabla general de tareas, ordenarla y filtrarla por columnas. Las tareas requieren una fecha de terminación, pueden ser editadas por su creador y deben ser confirmadas como leídas por el empleado asignado. Los estados disponibles son 0%, 25%, 50%, 75% y Finalizada.

Los títulos admiten hasta 50 caracteres. La descripción conserva un historial acumulativo de anotaciones que pueden agregar el creador y el empleado asignado, sin sobrescribir lo anterior. Las filas finalizadas aparecen tachadas y se eliminan automáticamente 15 días después de su finalización; si se reabre una tarea, el plazo se cancela.

## Notificaciones móviles

Cada empleado debe pulsar **Activar notificaciones** una vez desde su propio teléfono y aceptar el permiso del navegador. Las claves Web Push se generan automáticamente y se guardan en `data/database.json`; por ello, el disco persistente debe estar montado correctamente en producción. En iPhone, la aplicación debe agregarse primero a la pantalla de inicio.

El botón **Instalar aplicación** incluye un asistente para seleccionar iPhone, Android o computadora y muestra las instrucciones apropiadas para cada dispositivo.

## Vendedores y monitoreo de ubicación

El administrador puede crear cuentas con rol **Vendedor** desde la sección Empleados. Este rol conserva los mismos permisos operativos de un empleado y además dispone del módulo **Jornada** para iniciar o finalizar voluntariamente una jornada de ubicación.

Mientras la jornada está activa, Avanza obtiene posiciones del GPS y las envía como máximo una vez cada 15 segundos. Sólo los administradores pueden consultar la última posición, hora, precisión y estado de los vendedores. Los puntos se conservan durante 30 días en las colecciones independientes `trackingSessions` y `locationPoints`.

La geolocalización requiere HTTPS en producción (`localhost` funciona para pruebas), autorización explícita del vendedor y mantener Avanza abierta o activa. Los navegadores móviles pueden suspender una PWA en segundo plano; para seguimiento garantizado con la pantalla bloqueada será necesaria una aplicación móvil nativa.

## Clientes y visitas

El menú único **Jornada** está disponible para administradores y vendedores. Todos ven las empresas existentes y los clientes nuevos en una lista y un mapa compacto. Las empresas sin coordenadas se muestran como **Sin ubicación**; se pueden ubicar con el GPS, coordenadas o un punto elegido en el mapa. Los vendedores pueden completar ubicaciones vacías; solo un administrador puede corregir una ubicación existente.

Cada vendedor puede agregar clientes y registrar llegada, salida, resultado y notas. Una visita en curso debe finalizarse antes de iniciar otra. Cuando no se obtiene GPS, o la llegada está a más de 200 metros del cliente, se solicita un motivo. Las visitas conservan la hora del celular y la fecha de recepción del servidor. Los clientes nuevos no crean automáticamente cuentas de acceso o grupos de chat.

**Visitas del día** permite consultar las paradas de una fecha; el administrador también elige vendedor. Las paradas se numeran por llegada y se unen con líneas discontinuas: estas líneas no son calles recorridas ni una ruta optimizada. Las llegadas sin GPS permanecen en la lista. El monitoreo GPS está integrado en el mismo mapa: azul para el recorrido registrado y el vendedor, naranja para clientes y líneas discontinuas entre visitas. Se puede elegir vendedor y fecha, y ocultar cada capa. Los trazos GPS se separan entre sesiones y ante interrupciones de más de dos minutos.

Para trabajar sin internet, inicia sesión y abre **Jornada** con conexión una vez en ese dispositivo. La aplicación conserva los clientes y los registros en el almacenamiento local del navegador, separados por cuenta. Se puede reabrir sin señal usando la última sesión local; enviar datos siempre requiere una sesión válida en el servidor. El botón **Sincronizar**, la recuperación de conexión y un reintento cada 30 segundos mientras Avanza permanece abierta procesan la cola. Cada operación tiene un identificador estable para evitar duplicados si se pierde la respuesta. Si la sesión vence, hay que iniciar sesión de nuevo; los registros pendientes se conservan. No borres los datos del navegador mientras existan pendientes.

El mapa base necesita internet; no se descargan zonas para uso sin conexión. La lista, los formularios y los registros sí funcionan sin señal. No se garantiza sincronización con la aplicación cerrada. La geolocalización necesita HTTPS o localhost. Las pruebas automáticas del módulo se ejecutan con `node --test tests/*.test.cjs`; no usan la base de datos de trabajo.

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

En Jornada, el vendedor inicia o finaliza su seguimiento desde la misma pantalla. El administrador consulta al equipo sin activar GPS en su dispositivo. Si falla el envío del cierre, el GPS se detiene en el celular y la intención de cierre se conserva para reintentar al recuperar conexión. La actualización del monitoreo se realiza cada 30 segundos mientras la pantalla está abierta.
