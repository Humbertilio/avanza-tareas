# Avanza Vendedores Android

Aplicación nativa complementaria al portal Avanza. Solo permite cuentas activas con rol `seller`. Abre el portal en el navegador para las demás funciones. Android mínimo 8 (API 26), objetivo Android 15 (API 35).

## Funcionamiento

- Inicio explícito con aplicación visible, ubicación precisa y permiso de notificaciones. Requiere conexión para comprobar cuenta y jornada abierta.
- Servicio de ubicación en primer plano, con notificación permanente y bloqueo parcial de CPU durante la jornada. Programa una toma inmediata y luego cada 300000 ms; solicita GPS/red durante hasta 60 segundos y conserva la mejor ubicación reciente. Android/OEM puede retrasar o interrumpir la ejecución: no es un reloj de tiempo real.
- SQLite local: orden de inicio → puntos → cierre. Se confirma cada lote antes de borrarlo del teléfono. Hora de captura original y hora de recepción diferenciadas en el servidor. Reintentos idempotentes.
- Finalizar detiene GPS y libera el bloqueo de CPU de inmediato, incluso sin red. JobScheduler reintenta pendientes con conexión; puede demorarse por políticas de Android. Abrir la app también sincroniza.
- Tras reinicio, cierre forzado o interrupción, el vendedor debe abrir la app y pulsar Reanudar GPS. No se solicita acceso secreto ni reinicio automático del seguimiento desde el arranque.
- Token de alcance exclusivo móvil, vencimiento a 90 días, cifrado con Android Keystore, backup desactivado. Cambio de contraseña, rol o desactivación invalida el acceso. Datos pendientes quedan vinculados a la cuenta original.
- El portal evita registrar GPS duplicado o cerrar una jornada Android; se finaliza desde la app nativa.

## Compilación

Requiere JDK 17, Gradle 8.11.1, Android SDK 35/build-tools 35.0.0. Desde la raíz: `gradle -p android assembleDebug lintDebug`. APK de desarrollo: `android/app/build/outputs/apk/debug/app-debug.apk`.

Para distribución: definir `AVANZA_KEYSTORE` (ruta absoluta), `AVANZA_STORE_PASSWORD` y alias `avanza`; ejecutar `gradle -p android assembleRelease lintRelease`. Mantener la misma clave para actualizaciones. El almacén local en `.signing` está excluido de Git y debe respaldarse por el propietario. No subir claves o contraseñas al repositorio.

## Validación en teléfono

Antes de instalar a todos los vendedores, comprobar en un Android real: iniciar, recibir primera captura, bloquear pantalla al menos 15 minutos, revisar varias capturas separadas aproximadamente 5 minutos; desactivar datos, comprobar pendientes, finalizar sin red, restablecer conexión y comprobar horas y cierre en Jornada. Repetir con ahorro de batería, permiso revocado, cierre de proceso, reinicio, contraseña cambiada y cuenta no vendedora. No hay teléfono conectado al entorno de desarrollo: la compilación y las pruebas del servidor no sustituyen esta validación física.

La copia marcada como publicada corresponde al APK firmado en `public/downloads/avanza-vendedores.apk`. Página para vendedores: `/android.html`.

Referencias: https://developer.android.com/develop/background-work/services/fgs/service-types#location y https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start .
