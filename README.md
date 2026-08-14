# Avanza — gestor de tareas para empleados

Aplicación web multiusuario, adaptable a teléfonos y computadoras. Cualquier empleado puede crear y asignar una tarea; solamente el empleado asignado puede cambiar su avance entre 25%, 50%, 75% y Finalizada.

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
