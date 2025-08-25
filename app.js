const express = require("express");
const { PrismaClient } = require("./generated/prisma");
const cors = require("cors");
const prisma = new PrismaClient();
const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

app.get("/productos", async (req, res) => {
  const categorias = await prisma.categorias.findMany({
    // where: { id_categoria: 1 },
    include: {
      productos: {
        orderBy: {
          precio_venta: "asc",
        },
        select: {
          id_producto: true,
          nombre: true,
          precio_venta: true,
          codigos: true,
        },
      },
    },
  });
  res.send(categorias);
});

app.get("/ganancias", async (req, res) => {
  const { inicio, fin } = req.query;

  const ventas = await prisma.productos_vendidos.findMany({
    include: {
      productos: true,
      ventas: true,
    },
  });

  // Función para parsear fechas del formato: "06/04/2025, 10:59:36"
  const parseFecha = (fechaStr) => {
    const [fecha, hora] = fechaStr.split(", ");
    const [mes, dia, anio] = fecha.split("/").map(Number); // <- importante
    const [h, m, s] = hora.split(":").map(Number);
    return new Date(anio, mes - 1, dia, h, m, s);
  };

  // Si no hay parámetros, usar el mes actual
  const now = new Date();
  const defaultInicio = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultFin = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23,
    59,
    59
  );

  const fechaInicio = inicio
    ? parseFecha(`${inicio}, 00:00:00`)
    : defaultInicio;
  const fechaFin = fin ? parseFecha(`${fin}, 23:59:59`) : defaultFin;

  // Inicializar todos los días del mes en 0
  const diasDelMes = {};
  const diasEnElMes = new Date(
    fechaInicio.getFullYear(),
    fechaInicio.getMonth() + 1,
    0
  ).getDate();

  for (let dia = 1; dia <= diasEnElMes; dia++) {
    const fecha = new Date(
      fechaInicio.getFullYear(),
      fechaInicio.getMonth(),
      dia
    );
    const clave = fecha.toISOString().split("T")[0]; // "YYYY-MM-DD"
    diasDelMes[clave] = {
      fecha: clave,
      gananciaTotal: 0,
      gananciaNeta: 0,
    };
  }

  // Procesar ventas y acumular por día
  for (const venta of ventas) {
    const fechaVenta = parseFecha(venta.ventas.fecha_venta);

    if (fechaVenta < fechaInicio || fechaVenta > fechaFin) continue;

    const clave = fechaVenta.toISOString().split("T")[0];

    const precioVenta = venta.productos.precio_venta;
    let precioCompra = venta.productos.precio_compra;
    const cantidad = venta.cantidad;

    // Calcular precioCompra si es 0
    if (precioCompra === 0) {
      if (precioVenta <= 1) {
        precioCompra = precioVenta * 0.69;
      } else if (precioVenta <= 2) {
        precioCompra = precioVenta * 0.75;
      } else {
        precioCompra = precioVenta * 0.8;
      }
    }

    const total = precioVenta * cantidad;
    const neto = (precioVenta - precioCompra) * cantidad;

    // Sumar al día correspondiente
    if (!diasDelMes[clave]) {
      diasDelMes[clave] = {
        fecha: clave,
        gananciaTotal: 0,
        gananciaNeta: 0,
      };
    }

    diasDelMes[clave].gananciaTotal += total;
    diasDelMes[clave].gananciaNeta += neto;
  }

  // Convertir en array y redondear
  const resultado = Object.values(diasDelMes).map((dia) => ({
    fecha: dia.fecha,
    gananciaTotal: dia.gananciaTotal.toFixed(2),
    gananciaNeta: dia.gananciaNeta.toFixed(2),
  }));

  res.send(resultado);
});

app.get("/mas-vendidos", async (req, res) => {
  try {
    const productosMasVendidos = await prisma.productos_vendidos.groupBy({
      by: ["producto_id"],
      _sum: {
        cantidad: true,
      },
      orderBy: {
        _sum: {
          cantidad: "desc",
        },
      },
      // take: 10, // top 10 más vendidos
    });

    const ids = productosMasVendidos.map((p) => p.producto_id);

    const productos = await prisma.productos.findMany({
      where: {
        id_producto: { in: ids },
      },
      select: {
        id_producto: true,
        nombre: true,
        precio_venta: true,
        codigos: true,
      },
    });

    // Unimos la suma de cantidad con los datos del producto
    const resultado = productosMasVendidos.map((vendido) => {
      const producto = productos.find(
        (p) => p.id_producto === vendido.producto_id
      );
      return {
        ...producto,
        cantidad_vendida: vendido._sum.cantidad,
      };
    });

    res.json(resultado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener productos más vendidos" });
  }
});

app.post("/agregar_codigo", async (req, res) => {
  const { code, product } = req.body;

  if (!code || !product) {
    return res
      .status(400)
      .json({ error: "Faltan campos requeridos: code y product" });
  }

  const productId = parseInt(product); // Asegúrate de que sea un número

  try {
    // Buscar el producto
    const producto = await prisma.productos.findUnique({
      where: {
        id_producto: productId,
      },
    });

    if (!producto) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    // Obtener los códigos actuales o iniciar un array nuevo
    let codigos = Array.isArray(producto.codigos) ? producto.codigos : [];

    // Agregar el nuevo código si no existe ya (opcional)
    if (!codigos.includes(code)) {
      codigos.push(code);
    }

    // Actualizar el producto
    await prisma.productos.update({
      where: {
        id_producto: productId,
      },
      data: {
        codigos: codigos,
      },
    });

    return res
      .status(200)
      .json({ mensaje: "Código agregado correctamente", codigos });
  } catch (error) {
    console.error("Error al agregar código:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Endpoint: obtener productos sin codigos, agrupados y ordenados por categoría
app.get("/productos/sin-codigo", async (req, res) => {
  try {
    const productos = await prisma.productos.findMany({
      where: {
        codigos: {
          equals: [],
        },
      },
      include: {
        categorias: true,
      },
      orderBy: {
        categorias: {
          nombre: "asc",
        },
      },
    });

    // Agrupar por categoría
    const agrupadosPorCategoria = productos.reduce((acc, producto) => {
      const nombreCategoria = producto.categorias.nombre;
      if (!acc[nombreCategoria]) {
        acc[nombreCategoria] = [];
      }
      acc[nombreCategoria].push(producto);
      return acc;
    }, {});

    res.json(agrupadosPorCategoria);
  } catch (error) {
    console.error("Error al obtener productos sin código:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

//******************VENTAS*****************

app.post("/venta", async (req, res) => {
  const data = req.body;

  console.log("Productos recibidos:", data);

  if (!data || !Array.isArray(data) || data.length === 0) {
    return res
      .status(400)
      .send("No se han proporcionado productos para la venta.");
  }

  try {
    const fecha_venta = new Intl.DateTimeFormat("es-PA", {
      timeZone: "America/Panama",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());

    const venta = await prisma.ventas.create({
      data: {
        fecha_venta,
        productos_vendidos: {
          create: data.map((p) => ({
            cantidad: p.cantidad,
            producto_id: p.id_producto,
          })),
        },
      },
      include: {
        productos_vendidos: true,
      },
    });
    res.status(201).send(venta);
  } catch (error) {
    console.error("Error al crear la venta:", error);
    res.status(500).send("Error al procesar la venta.");
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Example app listening on port ${port}`);
});
