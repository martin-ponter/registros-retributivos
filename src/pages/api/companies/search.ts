import type { APIRoute } from "astro";

export const prerender = false;

type BitrixCompany = {
    ID: string;
    TITLE?: string;
    COMPANY_TITLE?: string;
    [key: string]: unknown;
};

type CompanySearchResult = {
    id: string;
    title: string;
    cif?: string;
};

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL?.replace(/\/$/, "");
const CIF_FIELD = process.env.BITRIX_COMPANY_CIF_FIELD || "";

export const GET: APIRoute = async ({ request }) => {
    try {
        const url = new URL(request.url);
        const query = url.searchParams.get("query")?.trim() || "";

        if (query.length < 2) {
            return json([]);
        }

        if (!BITRIX_WEBHOOK_URL) {
            return json(
                {
                    error: "Falta BITRIX_WEBHOOK_URL en variables de entorno.",
                },
                500,
            );
        }

        const results = new Map<string, CompanySearchResult>();

        const byName = await searchCompaniesByTitle(query);

        for (const company of byName) {
            const normalized = normalizeCompany(company);
            results.set(normalized.id, normalized);
        }

        if (CIF_FIELD) {
            const byCif = await searchCompaniesByCif(query);

            for (const company of byCif) {
                const normalized = normalizeCompany(company);
                results.set(normalized.id, normalized);
            }
        }

        return json([...results.values()]);
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Error buscando empresas.";

        return json(
            {
                error: message,
            },
            500,
        );
    }
};

async function searchCompaniesByTitle(query: string): Promise<BitrixCompany[]> {
    const result = await callBitrix("crm.company.list", {
        order: {
            TITLE: "ASC",
        },
        filter: {
            "%TITLE": query,
        },
        select: buildSelectFields(),
        start: 0,
    });

    return Array.isArray(result) ? (result as BitrixCompany[]) : [];
}

async function searchCompaniesByCif(query: string): Promise<BitrixCompany[]> {
    if (!CIF_FIELD) return [];

    const result = await callBitrix("crm.company.list", {
        order: {
            TITLE: "ASC",
        },
        filter: {
            [`%${CIF_FIELD}`]: query,
        },
        select: buildSelectFields(),
        start: 0,
    });

    return Array.isArray(result) ? (result as BitrixCompany[]) : [];
}

function buildSelectFields(): string[] {
    const fields = ["ID", "TITLE"];

    if (CIF_FIELD) {
        fields.push(CIF_FIELD);
    }

    return fields;
}

function normalizeCompany(company: BitrixCompany): CompanySearchResult {
    const title =
        stringValue(company.TITLE) ||
        stringValue(company.COMPANY_TITLE) ||
        `Empresa ${company.ID}`;

    const cif = CIF_FIELD ? stringValue(company[CIF_FIELD]) : "";

    return {
        id: String(company.ID),
        title,
        cif: cif || undefined,
    };
}

async function callBitrix(
    method: string,
    params: Record<string, unknown>,
): Promise<unknown> {
    if (!BITRIX_WEBHOOK_URL) {
        throw new Error("Falta BITRIX_WEBHOOK_URL.");
    }

    const response = await fetch(`${BITRIX_WEBHOOK_URL}/${method}.json`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !isObject(data) || data.error) {
        const description = isObject(data)
            ? stringValue(data.error_description) || stringValue(data.error)
            : "";

        throw new Error(
            description || `Error llamando a Bitrix REST: ${response.status}`,
        );
    }

    return data.result;
}

function stringValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
        },
    });
}
