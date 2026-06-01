import type { APIRoute } from "astro";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import Docxtemplater from "docxtemplater";
import dotenv from "dotenv";
import OpenAI from "openai";
import PizZip from "pizzip";

dotenv.config();

export const prerender = false;

type GenerateInformeRequest = {
    excelBase64?: string;
    excelFileName?: string;
    excelMimeType?: string;
    excelFileUrl?: string;
    bitrixExcelFileId?: string;
    templateBase64?: string;
    templatePath?: string;
    templateUrl?: string;
    contextText?: string;
    model?: string;
    maxOutputTokens?: number;
    outputFileName?: string;
    bitrixFolderId?: string;
};

type InputFile = {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
};

type ReportData = Record<string, string | Array<Record<string, string>>>;

const DEFAULT_MODEL = process.env.OPENAI_REPORT_MODEL || "gpt-5.4-mini";
const DEFAULT_MAX_OUTPUT_TOKENS = 22000;
const DEFAULT_TEMPLATE_PATH =
    process.env.RR_TEMPLATE_DOCX_PATH ||
    path.join(process.cwd(), "plantilla_informe_ponter_descarga.docx");
const DEFAULT_TEMPLATE_URL = process.env.RR_TEMPLATE_DOCX_URL || "";

export const POST: APIRoute = async ({ request }) => {
    try {
        const payload = await readRequestPayload(request);
        const excel = await resolveExcelFile(payload, request);
        const templateBuffer = await resolveTemplateBuffer(payload, request);

        const data = await generateReportData({
            excel,
            contextText: payload.contextText,
            model: payload.model || DEFAULT_MODEL,
            maxOutputTokens:
                parsePositiveInt(payload.maxOutputTokens) ||
                DEFAULT_MAX_OUTPUT_TOKENS,
        });

        const docxBuffer = await renderDocxTemplate({
            templateBuffer,
            data,
        });

        const outputFileName =
            payload.outputFileName ||
            buildOutputFileName({
                company: stringValue(data.empresa),
                year: stringValue(data.anio),
            });

        const unresolvedTags = findUnresolvedTemplateTags(docxBuffer);
        const bitrixFolderId =
            payload.bitrixFolderId || process.env.RR_BITRIX_DRIVE_FOLDER_ID;

        const upload = bitrixFolderId
            ? await uploadToBitrixDrive({
                  folderId: bitrixFolderId,
                  fileName: outputFileName,
                  buffer: docxBuffer,
              })
            : null;

        return jsonResponse({
            ok: true,
            fileName: outputFileName,
            bitrixUpload: upload,
            unresolvedTags,
            data,
            docxBase64: upload ? undefined : docxBuffer.toString("base64"),
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Error generando informe.";

        return jsonResponse(
            {
                ok: false,
                error: message,
            },
            500,
        );
    }
};

async function readRequestPayload(
    request: Request,
): Promise<GenerateInformeRequest & { formData?: FormData }> {
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();

        return {
            formData,
            excelFileName: getFormString(formData, "excelFileName"),
            excelMimeType: getFormString(formData, "excelMimeType"),
            excelFileUrl: getFormString(formData, "excelFileUrl"),
            bitrixExcelFileId: getFormString(formData, "bitrixExcelFileId"),
            templatePath: getFormString(formData, "templatePath"),
            templateUrl: getFormString(formData, "templateUrl"),
            contextText: getFormString(formData, "contextText"),
            model: getFormString(formData, "model"),
            maxOutputTokens: parsePositiveInt(
                getFormString(formData, "maxOutputTokens"),
            ),
            outputFileName: getFormString(formData, "outputFileName"),
            bitrixFolderId: getFormString(formData, "bitrixFolderId"),
        };
    }

    if (!contentType.includes("application/json")) {
        throw new Error(
            "El endpoint espera application/json o multipart/form-data.",
        );
    }

    return (await request.json()) as GenerateInformeRequest;
}

async function resolveExcelFile(
    payload: GenerateInformeRequest & { formData?: FormData },
    request: Request,
): Promise<InputFile> {
    const formFile = payload.formData?.get("excel");

    if (formFile instanceof File) {
        const arrayBuffer = await formFile.arrayBuffer();

        return {
            buffer: Buffer.from(arrayBuffer),
            fileName: formFile.name || "registro-retributivo.xlsx",
            mimeType:
                formFile.type ||
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        };
    }

    if (payload.bitrixExcelFileId) {
        return fetchBitrixDriveFile(payload.bitrixExcelFileId);
    }

    if (payload.excelFileUrl) {
        return fetchRemoteFile({
            url: payload.excelFileUrl,
            fileName:
                payload.excelFileName || fileNameFromUrl(payload.excelFileUrl),
            request,
        });
    }

    if (payload.excelBase64) {
        const base64 = stripDataUrlPrefix(payload.excelBase64);

        return {
            buffer: Buffer.from(base64, "base64"),
            fileName: payload.excelFileName || "registro-retributivo.xlsx",
            mimeType:
                payload.excelMimeType ||
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        };
    }

    throw new Error(
        "Falta el Excel. Envia excelBase64, excelFileUrl, bitrixExcelFileId o un multipart con campo excel.",
    );
}

async function resolveTemplateBuffer(
    payload: GenerateInformeRequest & { formData?: FormData },
    request: Request,
): Promise<Buffer> {
    const formFile = payload.formData?.get("template");

    if (formFile instanceof File) {
        return Buffer.from(await formFile.arrayBuffer());
    }

    if (payload.templateBase64) {
        return Buffer.from(
            stripDataUrlPrefix(payload.templateBase64),
            "base64",
        );
    }

    const templateUrl = payload.templateUrl || DEFAULT_TEMPLATE_URL;

    if (templateUrl) {
        return fetchTemplateFromUrl(templateUrl, request);
    }

    const templatePath = path.isAbsolute(
        payload.templatePath || DEFAULT_TEMPLATE_PATH,
    )
        ? payload.templatePath || DEFAULT_TEMPLATE_PATH
        : path.join(
              process.cwd(),
              payload.templatePath || DEFAULT_TEMPLATE_PATH,
          );

    return fs.readFile(templatePath);
}

async function fetchTemplateFromUrl(
    templateUrl: string,
    request: Request,
): Promise<Buffer> {
    const url =
        templateUrl.startsWith("http://") || templateUrl.startsWith("https://")
            ? templateUrl
            : new URL(
                  templateUrl.startsWith("/") ? templateUrl : `/${templateUrl}`,
                  request.url,
              ).toString();

    const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
    });

    if (!response.ok) {
        throw new Error(
            `No se ha podido descargar la plantilla DOCX desde ${url}. HTTP ${response.status}`,
        );
    }

    return Buffer.from(await response.arrayBuffer());
}

async function generateReportData(params: {
    excel: InputFile;
    contextText?: string;
    model: string;
    maxOutputTokens: number;
}): Promise<ReportData> {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("Falta OPENAI_API_KEY en .env.");
    }

    const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await client.responses.create({
        model: params.model,
        input: [
            {
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text: buildPrompt({
                            contextText: params.contextText,
                            excelFileName: params.excel.fileName,
                        }),
                    },
                    {
                        type: "input_file",
                        filename: params.excel.fileName,
                        file_data: buildOpenAIFileData(params.excel),
                    },
                ],
            },
        ],
        text: {
            format: {
                type: "json_schema",
                name: "registro_retributivo_informe",
                strict: true,
                schema: buildReportJsonSchema(),
            },
        },
        max_output_tokens: params.maxOutputTokens,
    });

    const outputText = response.output_text || "";

    if (!outputText.trim()) {
        throw new Error("El modelo no ha devuelto contenido.");
    }

    return normalizeReportData(parseModelJson(outputText));
}

function buildPrompt(params: {
    contextText?: string;
    excelFileName: string;
}): string {
    return `
Eres un especialista en informes de registro retributivo, igualdad retributiva y analisis laboral en Espana.

OBJETIVO
Analiza el Excel adjunto (${params.excelFileName}) y genera los datos estructurados necesarios para rellenar una plantilla DOCX de informe de registro retributivo.

MUY IMPORTANTE
- Devuelve exclusivamente JSON valido conforme al esquema solicitado.
- No devuelvas markdown.
- No devuelvas HTML.
- No expliques nada.
- No inventes datos.
- La fuente de verdad para empresa, CIF, ano, periodo, personas trabajadoras, categorias, importes, brechas y agrupaciones es el Excel adjunto completo.
- Si un dato no aparece en el Excel ni en el contexto adicional, usa "Dato no disponible".
- Si no hay datos suficientes para una tabla, devuelve un array vacio [].
- Si hay categorias monosexuales, indicalo en observaciones y limitaciones.
- Usa formato espanol:
  - Porcentajes con coma decimal cuando proceda, ejemplo: "16,5%".
  - Importes en euros, ejemplo: "18.450,32 EUR".
  - Fechas en espanol, ejemplo: "7 de mayo de 2026".
- No copies datos de una empresa modelo si no aparecen en el Excel.
- Las conclusiones deben estar justificadas por los datos.
- El informe debe ser prudente: no afirmes discriminacion si solo hay indicios o diferencias sin analisis causal.

CRITERIOS DE ANALISIS
- Para categorias con mujeres y hombres, calcula diferencias entre sexos.
- Para categorias con un solo sexo, no calcules brecha directa; explica que no hay comparativa directa.
- Marca como alerta cualquier diferencia relevante, especialmente si supera el 25%.
- Distingue cuando puedas:
  - salario base
  - complementos salariales
  - extrasalarial
  - retribucion total
- Si existen importes efectivos y equiparados, prioriza los equiparados para comparabilidad y usa efectivos como apoyo.
- El plan de accion debe ser realista y accionable.

CAMPOS DE LA PLANTILLA
Debes devolver todas las claves del JSON aunque alguna sea "Dato no disponible".

La plantilla contiene campos simples como:
anio, empresa, cif, convenio_colectivo, periodo_inicio_largo, periodo_fin_largo, elaborado_por, area_elaboracion, fecha_elaboracion, version, texto_alcance_registro, domicilio_social, codigo_cnae, actividad_cnae, ambito_convenio, total_trabajadores, fecha_referencia, representacion_legal, periodo_resumen, responsable_elaboracion, texto_fuentes_datos, texto_metodologia_comparativa_sectorial, texto_limitacion_categorias_monosexuales, texto_estructura_plantilla, texto_distribucion_grupos, texto_complementos_salariales, texto_retribucion_total, texto_categorias_comparativa_directa, texto_brecha_global_ponderada, icono_alerta_brecha_global, texto_alerta_brecha_global, texto_analisis_grupos_cotizacion, texto_intro_factores_explicativos, icono_info_sectorial, texto_info_sectorial, texto_intro_plan_accion, conclusion_1_icono, conclusion_1_texto, conclusion_2_icono, conclusion_2_texto, conclusion_3_icono, conclusion_3_texto, conclusion_4_icono, conclusion_4_texto, conclusion_5_icono, conclusion_5_texto, firmante_empresa, cargo_firmante_empresa, fecha_firma_empresa, fecha_firma_lugar, footer_texto.

La plantilla tambien contiene arrays:
categorias_plantilla, grupos_cotizacion, salario_base_categorias, complementos_categorias, retribucion_total_categorias, categorias_comparables, analisis_grupos_cotizacion, factores_explicativos, comparativa_sectorial, plan_accion.

CONTEXTO ADICIONAL DEL USUARIO
${params.contextText || "Sin contexto adicional."}
`.trim();
}

function buildReportJsonSchema() {
    const stringField = {
        type: "string",
    };

    const tableArray = (properties: Record<string, typeof stringField>) => ({
        type: "array",
        items: {
            type: "object",
            additionalProperties: false,
            properties,
            required: Object.keys(properties),
        },
    });

    const scalarKeys = [
        "anio",
        "empresa",
        "cif",
        "convenio_colectivo",
        "periodo_inicio_largo",
        "periodo_fin_largo",
        "elaborado_por",
        "area_elaboracion",
        "fecha_elaboracion",
        "version",
        "texto_alcance_registro",
        "domicilio_social",
        "codigo_cnae",
        "actividad_cnae",
        "ambito_convenio",
        "total_trabajadores",
        "fecha_referencia",
        "representacion_legal",
        "periodo_resumen",
        "responsable_elaboracion",
        "texto_fuentes_datos",
        "texto_metodologia_comparativa_sectorial",
        "texto_limitacion_categorias_monosexuales",
        "texto_estructura_plantilla",
        "texto_distribucion_grupos",
        "texto_complementos_salariales",
        "texto_retribucion_total",
        "texto_categorias_comparativa_directa",
        "texto_brecha_global_ponderada",
        "icono_alerta_brecha_global",
        "texto_alerta_brecha_global",
        "texto_analisis_grupos_cotizacion",
        "texto_intro_factores_explicativos",
        "icono_info_sectorial",
        "texto_info_sectorial",
        "texto_intro_plan_accion",
        "conclusion_1_icono",
        "conclusion_1_texto",
        "conclusion_2_icono",
        "conclusion_2_texto",
        "conclusion_3_icono",
        "conclusion_3_texto",
        "conclusion_4_icono",
        "conclusion_4_texto",
        "conclusion_5_icono",
        "conclusion_5_texto",
        "firmante_empresa",
        "cargo_firmante_empresa",
        "fecha_firma_empresa",
        "fecha_firma_lugar",
        "footer_texto",
    ];

    const properties: Record<string, unknown> = {};

    for (const key of scalarKeys) {
        properties[key] = stringField;
    }

    properties.categorias_plantilla = tableArray({
        categoria_profesional: stringField,
        grupo: stringField,
        mujeres: stringField,
        hombres: stringField,
        total: stringField,
        porcentaje_mujeres: stringField,
        porcentaje_hombres: stringField,
        jornada_mujeres: stringField,
        jornada_hombres: stringField,
    });

    properties.grupos_cotizacion = tableArray({
        grupo: stringField,
        mujeres: stringField,
        hombres: stringField,
        total: stringField,
        porcentaje_mujeres_grupo: stringField,
        observacion: stringField,
    });

    properties.salario_base_categorias = tableArray({
        categoria_profesional: stringField,
        mujeres: stringField,
        hombres: stringField,
        salario_base_mujeres: stringField,
        salario_base_hombres: stringField,
        diferencia_salario_base: stringField,
        observacion: stringField,
    });

    properties.complementos_categorias = tableArray({
        categoria_profesional: stringField,
        complementos_mujeres: stringField,
        complementos_hombres: stringField,
        porcentaje_complementos_mujeres: stringField,
        porcentaje_complementos_hombres: stringField,
        diferencia_complementos: stringField,
        tendencia: stringField,
    });

    properties.retribucion_total_categorias = tableArray({
        categoria_profesional: stringField,
        total_retribucion_mujeres: stringField,
        total_retribucion_hombres: stringField,
        retribucion_hora_mujeres: stringField,
        retribucion_hora_hombres: stringField,
        diferencia_total: stringField,
        alerta: stringField,
    });

    properties.categorias_comparables = tableArray({
        categoria_profesional: stringField,
        diferencia_salario_base: stringField,
        diferencia_complementos: stringField,
        diferencia_total: stringField,
        valoracion_regulatoria: stringField,
    });

    properties.analisis_grupos_cotizacion = tableArray({
        grupo: stringField,
        mujeres: stringField,
        hombres: stringField,
        comparables: stringField,
        brecha_media: stringField,
        interpretacion: stringField,
    });

    properties.factores_explicativos = tableArray({
        factor: stringField,
        analisis: stringField,
        accion_recomendada: stringField,
    });

    properties.comparativa_sectorial = tableArray({
        indicador: stringField,
        referencia_sectorial: stringField,
        dato_empresa: stringField,
        desviacion: stringField,
        observacion: stringField,
    });

    properties.plan_accion = tableArray({
        numero: stringField,
        accion: stringField,
        descripcion: stringField,
        plazo: stringField,
        responsable: stringField,
    });

    return {
        type: "object",
        additionalProperties: false,
        properties,
        required: Object.keys(properties),
    };
}

async function renderDocxTemplate(params: {
    templateBuffer: Buffer;
    data: ReportData;
}): Promise<Buffer> {
    const zip = new PizZip(params.templateBuffer);

    normalizeTemplateTags(zip);

    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        delimiters: {
            start: "{{",
            end: "}}",
        },
        nullGetter(part) {
            if (part?.module === "rawxml") return "";
            return "Dato no disponible";
        },
    });

    try {
        doc.render(params.data);
    } catch (error) {
        throw new Error(formatDocxtemplaterError(error));
    }

    return doc.getZip().generate({
        type: "nodebuffer",
        compression: "DEFLATE",
    }) as Buffer;
}

function normalizeTemplateTags(zip: PizZip): void {
    const xmlFileNames = Object.keys(zip.files).filter(
        (fileName) =>
            /\.xml$/i.test(fileName) &&
            (fileName.startsWith("word/") || fileName.startsWith("docProps/")),
    );

    for (const fileName of xmlFileNames) {
        const file = zip.file(fileName);

        if (!file) continue;

        const originalXml = file.asText();
        const nextXml = originalXml
            .replace(/\{#([a-zA-Z0-9_]+)\}/g, "{{$#$1}}")
            .replace(/\{\/([a-zA-Z0-9_]+)\}/g, "{{/$1}}")
            .replace(/\{\{\$#([a-zA-Z0-9_]+)\}\}/g, "{{#$1}}");

        if (nextXml !== originalXml) {
            zip.file(fileName, nextXml);
        }
    }
}

function findUnresolvedTemplateTags(docxBuffer: Buffer): string[] {
    const zip = new PizZip(docxBuffer);
    const found = new Set<string>();
    const xmlFileNames = Object.keys(zip.files).filter(
        (fileName) => /\.xml$/i.test(fileName) && fileName.startsWith("word/"),
    );

    for (const fileName of xmlFileNames) {
        const file = zip.file(fileName);

        if (!file) continue;

        const matches =
            file.asText().match(/\{\{[^}]+\}\}|\{[#/][^}]+\}/g) || [];

        for (const match of matches) {
            found.add(match);
        }
    }

    return [...found].sort();
}

function parseModelJson(text: string): unknown {
    const cleaned = cleanJsonText(text);

    try {
        return JSON.parse(cleaned);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `No se pudo parsear el JSON devuelto por OpenAI: ${message}`,
        );
    }
}

function cleanJsonText(text: string): string {
    let cleaned = String(text || "").trim();

    cleaned = cleaned
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```$/i, "")
        .trim();

    return cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;
}

function normalizeReportData(input: unknown): ReportData {
    const defaults = buildDefaultReportData();
    const source = isObject(input) ? input : {};
    const output: ReportData = {
        ...defaults,
        ...source,
    } as ReportData;

    for (const [key, defaultValue] of Object.entries(defaults)) {
        const value = output[key];

        if (Array.isArray(defaultValue)) {
            output[key] = Array.isArray(value) ? normalizeRows(value) : [];
            continue;
        }

        output[key] =
            value === null || value === undefined || String(value).trim() === ""
                ? defaultValue
                : String(value);
    }

    return output;
}

function buildDefaultReportData(): ReportData {
    return {
        anio: "Dato no disponible",
        empresa: "Dato no disponible",
        cif: "Dato no disponible",
        convenio_colectivo: "Dato no disponible",
        periodo_inicio_largo: "Dato no disponible",
        periodo_fin_largo: "Dato no disponible",
        elaborado_por: "Ponter Abogados S.L.",
        area_elaboracion: "Area Laboral",
        fecha_elaboracion: todayLongEs(),
        version: "1.0",
        texto_alcance_registro: "Dato no disponible",
        domicilio_social: "Dato no disponible",
        codigo_cnae: "Dato no disponible",
        actividad_cnae: "Dato no disponible",
        ambito_convenio: "Dato no disponible",
        total_trabajadores: "Dato no disponible",
        fecha_referencia: "Dato no disponible",
        representacion_legal: "Dato no disponible",
        periodo_resumen: "Dato no disponible",
        responsable_elaboracion: "Ponter Abogados S.L.",
        texto_fuentes_datos: "Dato no disponible",
        texto_metodologia_comparativa_sectorial: "Dato no disponible",
        texto_limitacion_categorias_monosexuales: "Dato no disponible",
        texto_estructura_plantilla: "Dato no disponible",
        texto_distribucion_grupos: "Dato no disponible",
        texto_complementos_salariales: "Dato no disponible",
        texto_retribucion_total: "Dato no disponible",
        texto_categorias_comparativa_directa: "Dato no disponible",
        texto_brecha_global_ponderada: "Dato no disponible",
        icono_alerta_brecha_global: "info",
        texto_alerta_brecha_global: "Dato no disponible",
        texto_analisis_grupos_cotizacion: "Dato no disponible",
        texto_intro_factores_explicativos: "Dato no disponible",
        icono_info_sectorial: "info",
        texto_info_sectorial:
            "No se incorpora comparativa sectorial externa al no constar datos sectoriales especificos en la documentacion analizada.",
        texto_intro_plan_accion:
            "El siguiente plan de accion recoge medidas recomendadas para reforzar la trazabilidad y neutralidad de la politica retributiva.",
        conclusion_1_icono: "info",
        conclusion_1_texto: "Dato no disponible",
        conclusion_2_icono: "info",
        conclusion_2_texto: "Dato no disponible",
        conclusion_3_icono: "info",
        conclusion_3_texto: "Dato no disponible",
        conclusion_4_icono: "info",
        conclusion_4_texto: "Dato no disponible",
        conclusion_5_icono: "info",
        conclusion_5_texto: "Dato no disponible",
        firmante_empresa: "____________________________________",
        cargo_firmante_empresa: "____________________________________",
        fecha_firma_empresa: "____________________________________",
        fecha_firma_lugar: todayMonthYearEs(),
        footer_texto:
            "Ponter Abogados S.L. - Toledo - Madrid - Alcobendas - Consuegra - www.ponter.es - Area Laboral",
        categorias_plantilla: [],
        grupos_cotizacion: [],
        salario_base_categorias: [],
        complementos_categorias: [],
        retribucion_total_categorias: [],
        categorias_comparables: [],
        analisis_grupos_cotizacion: [],
        factores_explicativos: [],
        comparativa_sectorial: [],
        plan_accion: [],
    };
}

async function fetchBitrixDriveFile(fileId: string): Promise<InputFile> {
    const fileInfo = await callBitrix("disk.file.get", { id: fileId });
    const info = isObject(fileInfo) ? fileInfo : {};
    const downloadUrl =
        stringValue(info.DOWNLOAD_URL) ||
        stringValue(info.downloadUrl) ||
        stringValue(info.download_url);
    const fileName =
        stringValue(info.NAME) ||
        stringValue(info.name) ||
        `registro-retributivo-${fileId}.xlsx`;

    if (!downloadUrl) {
        throw new Error(
            "Bitrix no ha devuelto DOWNLOAD_URL para el archivo Excel.",
        );
    }

    return fetchRemoteFile({
        url: downloadUrl,
        fileName,
    });
}

async function fetchRemoteFile(params: {
    url: string;
    fileName: string;
    request?: Request;
}): Promise<InputFile> {
    const response = await fetch(params.url, {
        headers: params.request
            ? {
                  cookie: params.request.headers.get("cookie") || "",
              }
            : undefined,
    });

    if (!response.ok) {
        throw new Error(
            `No se pudo descargar el Excel (${response.status} ${response.statusText}).`,
        );
    }

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        fileName: params.fileName || fileNameFromUrl(params.url),
        mimeType:
            response.headers.get("content-type") ||
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
}

async function uploadToBitrixDrive(params: {
    folderId: string;
    fileName: string;
    buffer: Buffer;
}): Promise<unknown> {
    return callBitrix("disk.folder.uploadfile", {
        id: params.folderId,
        data: {
            NAME: params.fileName,
        },
        fileContent: [params.fileName, params.buffer.toString("base64")],
    });
}

async function callBitrix(
    method: string,
    params: Record<string, unknown>,
): Promise<unknown> {
    const baseUrl = process.env.BITRIX_WEBHOOK_URL?.trim();

    if (!baseUrl) {
        throw new Error("Falta BITRIX_WEBHOOK_URL en .env.");
    }

    const url = `${baseUrl.replace(/\/$/, "")}/${method}.json`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });

    const result = await response.json().catch(() => null);

    if (!response.ok || !isObject(result) || result.error) {
        const description = isObject(result)
            ? stringValue(result.error_description) || stringValue(result.error)
            : "";

        throw new Error(
            description || `Error llamando a Bitrix REST: ${response.status}`,
        );
    }

    return result.result;
}

function formatDocxtemplaterError(error: unknown): string {
    const lines = ["Error al rellenar la plantilla DOCX."];
    const typedError = error as {
        message?: string;
        properties?: {
            errors?: Array<{
                message?: string;
                properties?: {
                    id?: string;
                    explanation?: string;
                    xtag?: string;
                };
            }>;
        };
    };

    if (typedError.message) {
        lines.push(typedError.message);
    }

    if (Array.isArray(typedError.properties?.errors)) {
        for (const item of typedError.properties.errors) {
            lines.push("");
            lines.push(`- ${item.properties?.id || "error"}`);
            lines.push(
                `  ${item.properties?.explanation || item.message || ""}`,
            );

            if (item.properties?.xtag) {
                lines.push(`  Tag: ${item.properties.xtag}`);
            }
        }
    }

    return lines.join("\n");
}

function buildOpenAIFileData(file: InputFile): string {
    const base64 = file.buffer.toString("base64");

    return `data:${file.mimeType};base64,${base64}`;
}

function buildOutputFileName(params: {
    company: string;
    year: string;
}): string {
    const company =
        params.company && params.company !== "Dato no disponible"
            ? params.company
            : "empresa";
    const year =
        params.year && params.year !== "Dato no disponible"
            ? params.year
            : String(new Date().getFullYear());

    return `informe-registro-retributivo-${sanitizeFileName(company)}-${sanitizeFileName(year)}.docx`;
}

function getFormString(formData: FormData, key: string): string | undefined {
    const value = formData.get(key);

    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
    const parsed = Number.parseInt(String(value || ""), 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stripDataUrlPrefix(value: string): string {
    return value.replace(/^data:[^;]+;base64,/i, "").trim();
}

function fileNameFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const name = path.basename(parsed.pathname);

        return name || "registro-retributivo.xlsx";
    } catch {
        return "registro-retributivo.xlsx";
    }
}

function sanitizeFileName(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 90)
        .toLowerCase();
}

function normalizeRows(value: unknown[]): Array<Record<string, string>> {
    return value.filter(isObject).map((row) => {
        const next: Record<string, string> = {};

        for (const [key, cellValue] of Object.entries(row)) {
            next[key] =
                cellValue === null || cellValue === undefined
                    ? "Dato no disponible"
                    : String(cellValue);
        }

        return next;
    });
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function todayLongEs(): string {
    return new Intl.DateTimeFormat("es-ES", {
        day: "numeric",
        month: "long",
        year: "numeric",
    }).format(new Date());
}

function todayMonthYearEs(): string {
    return new Intl.DateTimeFormat("es-ES", {
        month: "long",
        year: "numeric",
    }).format(new Date());
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
        },
    });
}
