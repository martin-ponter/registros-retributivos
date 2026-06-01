import { useEffect, useMemo, useState } from "react";
import {
    generateIaReport,
    getRrStatus,
    searchCompanies,
    type CompanySearchResult,
    type RrStatus,
} from "../lib/backend";
import { initBitrixApp, type CurrentBitrixUser } from "../lib/bitrix";

type LoadState = "idle" | "loading" | "success" | "error";

export default function RrApp() {
    const [insideBitrix, setInsideBitrix] = useState<boolean | null>(null);
    const [currentUser, setCurrentUser] = useState<CurrentBitrixUser | null>(
        null,
    );

    const [query, setQuery] = useState("");
    const [year, setYear] = useState(2025);

    const [companies, setCompanies] = useState<CompanySearchResult[]>([]);
    const [selectedCompany, setSelectedCompany] =
        useState<CompanySearchResult | null>(null);
    const [status, setStatus] = useState<RrStatus | null>(null);

    const [searchState, setSearchState] = useState<LoadState>("idle");
    const [statusState, setStatusState] = useState<LoadState>("idle");
    const [actionState, setActionState] = useState<LoadState>("idle");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const canSearch = query.trim().length >= 2;

    const canGenerateReport = Boolean(
        selectedCompany &&
        status?.excelBiloop?.exists &&
        status.excelBiloop?.bitrixFileId &&
        status.bitrixCompanyFolderId &&
        !status?.iaReport?.exists &&
        actionState !== "loading",
    );

    const headerUserLabel = useMemo(() => {
        if (insideBitrix === null) return "Inicializando Bitrix...";
        if (!insideBitrix) return "Modo desarrollo fuera de Bitrix";
        if (!currentUser) return "Usuario Bitrix no detectado";
        return `${currentUser.name}${currentUser.email ? ` · ${currentUser.email}` : ""}`;
    }, [insideBitrix, currentUser]);

    useEffect(() => {
        let mounted = true;

        initBitrixApp().then((result) => {
            if (!mounted) return;

            setInsideBitrix(result.insideBitrix);
            setCurrentUser(result.user);
        });

        return () => {
            mounted = false;
        };
    }, []);

    useEffect(() => {
        const trimmedQuery = query.trim();

        if (trimmedQuery.length < 2) {
            setCompanies([]);
            setSelectedCompany(null);
            setStatus(null);
            setSearchState("idle");
            setStatusState("idle");
            setActionState("idle");
            setErrorMessage(null);
            return;
        }

        let cancelled = false;

        const timeoutId = window.setTimeout(async () => {
            setErrorMessage(null);
            setSearchState("loading");

            try {
                const result = await searchCompanies(trimmedQuery);

                if (cancelled) return;

                setCompanies(result);
                setSearchState("success");
            } catch (error) {
                if (cancelled) return;

                setCompanies([]);
                setSearchState("error");
                setErrorMessage(
                    error instanceof Error
                        ? error.message
                        : "Error buscando empresas.",
                );
            }
        }, 350);

        return () => {
            cancelled = true;
            window.clearTimeout(timeoutId);
        };
    }, [query]);

    async function handleSearch() {
        if (!canSearch) return;

        setErrorMessage(null);
        setSelectedCompany(null);
        setStatus(null);
        setStatusState("idle");
        setActionState("idle");
        setSearchState("loading");

        try {
            const result = await searchCompanies(query.trim());
            setCompanies(result);
            setSearchState("success");
        } catch (error) {
            setCompanies([]);
            setSearchState("error");
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : "Error buscando empresas.",
            );
        }
    }

    async function handleSelectCompany(company: CompanySearchResult) {
        setSelectedCompany(company);
        setStatus(null);
        setErrorMessage(null);
        setStatusState("loading");
        setActionState("idle");

        try {
            const result = await getRrStatus({
                companyId: company.id,
                year,
            });

            setStatus(result);
            setStatusState("success");
        } catch (error) {
            setStatusState("error");
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : "Error consultando estado.",
            );
        }
    }

    async function handleGenerateIaReport() {
        if (!selectedCompany || !status) return;

        const bitrixExcelFileId = status.excelBiloop?.bitrixFileId;
        const bitrixFolderId = status.bitrixCompanyFolderId;

        if (!bitrixExcelFileId) {
            setErrorMessage("No se ha encontrado el ID del Excel de Biloop.");
            return;
        }

        if (!bitrixFolderId) {
            setErrorMessage(
                "No se ha encontrado la carpeta de empresa en Bitrix Drive.",
            );
            return;
        }

        setErrorMessage(null);
        setActionState("loading");

        try {
            await generateIaReport({
                bitrixExcelFileId,
                bitrixFolderId,
                outputFileName: buildIaReportFileName({
                    companyName: status.companyName,
                    cif: status.cif || selectedCompany.cif || "",
                    year,
                }),
                companyName: status.companyName,
                cif: status.cif || selectedCompany.cif,
                year,
                requestedByBitrixUserId: currentUser?.id,
            });

            const refreshed = await getRrStatus({
                companyId: selectedCompany.id,
                year,
            });

            setStatus(refreshed);
            setActionState("success");
        } catch (error) {
            setActionState("error");
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : "Error generando informe IA.",
            );
        }
    }

    function buildIaReportFileName(params: {
        companyName: string;
        cif: string;
        year: number;
    }): string {
        const cifPart = sanitizeFileName(params.cif || "sin-cif");
        const companyPart = sanitizeFileName(params.companyName || "empresa");

        return `informe-ia-${params.year}-${cifPart}-${companyPart}.docx`;
    }

    function sanitizeFileName(value: string): string {
        return value
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 120)
            .toLowerCase();
    }

    const statusMessage = status?.message || null;

    return (
        <main className="min-h-screen bg-gray-100 p-4 md:p-6">
            <section className="mx-auto max-w-6xl space-y-5">
                <header className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                            <p className="text-sm font-medium text-gray-500">
                                Ponter · Laboral
                            </p>

                            <h1 className="mt-1 text-2xl font-bold text-gray-950">
                                Registros Retributivos
                            </h1>

                            <p className="mt-2 max-w-3xl text-sm text-gray-600">
                                Busca una empresa por nombre o CIF, comprueba si
                                existe su Excel de Biloop en Bitrix Drive y
                                genera el informe IA.
                            </p>
                        </div>

                        <div className="rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-700">
                            {headerUserLabel}
                        </div>
                    </div>
                </header>

                {errorMessage && (
                    <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                        {errorMessage}
                    </div>
                )}

                <section className="grid gap-5 lg:grid-cols-[420px_1fr]">
                    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                        <h2 className="text-lg font-semibold text-gray-950">
                            Buscar empresa
                        </h2>

                        <div className="mt-4 space-y-3">
                            <label className="block">
                                <span className="text-sm font-medium text-gray-700">
                                    Nombre o CIF
                                </span>

                                <input
                                    value={query}
                                    onChange={(event) => {
                                        setQuery(event.target.value);
                                        setSelectedCompany(null);
                                        setStatus(null);
                                        setStatusState("idle");
                                        setActionState("idle");
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                            void handleSearch();
                                        }
                                    }}
                                    placeholder="Ej: 60392288S o ZORRILLA"
                                    className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none ring-0 transition focus:border-gray-900"
                                />
                            </label>

                            <label className="block">
                                <span className="text-sm font-medium text-gray-700">
                                    Año
                                </span>

                                <select
                                    value={year}
                                    onChange={(event) => {
                                        setYear(Number(event.target.value));
                                        setSelectedCompany(null);
                                        setStatus(null);
                                        setStatusState("idle");
                                        setActionState("idle");
                                    }}
                                    className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-gray-900"
                                >
                                    <option value={2025}>2025</option>
                                    <option value={2026}>2026</option>
                                </select>
                            </label>

                            <button
                                type="button"
                                onClick={() => void handleSearch()}
                                disabled={
                                    !canSearch || searchState === "loading"
                                }
                                className="w-full rounded-xl bg-gray-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
                            >
                                {searchState === "loading"
                                    ? "Buscando..."
                                    : "Buscar ahora"}
                            </button>
                        </div>

                        <div className="mt-5 space-y-2">
                            {query.trim().length < 2 && (
                                <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-600">
                                    Escribe al menos 2 caracteres para buscar
                                    por nombre o CIF.
                                </p>
                            )}

                            {query.trim().length >= 2 &&
                                searchState === "loading" && (
                                    <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-600">
                                        Buscando coincidencias...
                                    </p>
                                )}

                            {query.trim().length >= 2 &&
                                companies.length === 0 &&
                                searchState === "success" && (
                                    <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-600">
                                        No se han encontrado empresas.
                                    </p>
                                )}

                            {companies.map((company) => {
                                const selected =
                                    selectedCompany?.id === company.id;

                                return (
                                    <button
                                        key={company.id}
                                        type="button"
                                        onClick={() =>
                                            void handleSelectCompany(company)
                                        }
                                        className={`w-full rounded-xl border p-4 text-left transition ${
                                            selected
                                                ? "border-gray-950 bg-gray-950 text-white"
                                                : "border-gray-200 bg-white hover:bg-gray-50"
                                        }`}
                                    >
                                        <div className="font-semibold">
                                            {company.title}
                                        </div>

                                        <div
                                            className={
                                                selected
                                                    ? "text-gray-300"
                                                    : "text-gray-500"
                                            }
                                        >
                                            {company.cif || "Sin CIF detectado"}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                        <h2 className="text-lg font-semibold text-gray-950">
                            Estado del registro
                        </h2>

                        {!selectedCompany && (
                            <div className="mt-4 rounded-2xl bg-gray-50 p-6 text-sm text-gray-600">
                                Selecciona una empresa para ver si ya tiene
                                Excel de Biloop e informe generado.
                            </div>
                        )}

                        {selectedCompany && statusState === "loading" && (
                            <div className="mt-4 rounded-2xl bg-gray-50 p-6 text-sm text-gray-600">
                                Consultando Bitrix Drive...
                            </div>
                        )}

                        {selectedCompany && status && (
                            <div className="mt-4 space-y-4">
                                <div className="rounded-2xl bg-gray-50 p-4">
                                    <div className="text-sm text-gray-500">
                                        Empresa seleccionada
                                    </div>

                                    <div className="mt-1 text-lg font-bold text-gray-950">
                                        {status.companyName}
                                    </div>

                                    <div className="text-sm text-gray-600">
                                        CIF:{" "}
                                        {status.cif ||
                                            selectedCompany.cif ||
                                            "No informado"}{" "}
                                        · Año: {status.year}
                                    </div>

                                    {statusMessage && (
                                        <p className="mt-3 text-sm text-amber-700">
                                            {statusMessage}
                                        </p>
                                    )}
                                </div>

                                <div className="grid gap-3 md:grid-cols-3">
                                    <StatusCard
                                        title="Excel Biloop"
                                        exists={Boolean(
                                            status.excelBiloop?.exists,
                                        )}
                                        url={status.excelBiloop?.url}
                                        fileName={status.excelBiloop?.fileName}
                                    />

                                    <StatusCard
                                        title="Informe IA"
                                        exists={Boolean(
                                            status.iaReport?.exists,
                                        )}
                                        url={status.iaReport?.url}
                                        fileName={status.iaReport?.fileName}
                                    />

                                    <StatusCard
                                        title="Informe final"
                                        exists={Boolean(
                                            status.finalReport?.exists,
                                        )}
                                        url={status.finalReport?.url}
                                        fileName={status.finalReport?.fileName}
                                    />
                                </div>

                                {status.folderUrl && (
                                    <a
                                        href={status.folderUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-900 transition hover:bg-gray-50"
                                    >
                                        Abrir carpeta en Bitrix Drive
                                    </a>
                                )}

                                <div className="rounded-2xl border border-gray-200 p-4">
                                    <h3 className="font-semibold text-gray-950">
                                        Acciones disponibles
                                    </h3>

                                    <div className="mt-3 flex flex-wrap gap-3">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void handleGenerateIaReport()
                                            }
                                            disabled={!canGenerateReport}
                                            className="rounded-xl bg-gray-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
                                        >
                                            {actionState === "loading"
                                                ? "Generando informe..."
                                                : "Generar informe IA"}
                                        </button>

                                        {status.iaReport?.url && (
                                            <a
                                                href={status.iaReport.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-900 transition hover:bg-gray-50"
                                            >
                                                Descargar informe IA
                                            </a>
                                        )}

                                        {status.finalReport?.url && (
                                            <a
                                                href={status.finalReport.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-900 transition hover:bg-gray-50"
                                            >
                                                Descargar informe final
                                            </a>
                                        )}
                                    </div>

                                    {!status.excelBiloop?.exists && (
                                        <p className="mt-3 text-sm text-amber-700">
                                            No aparece el Excel de Biloop en
                                            Drive. Primero habrá que revisar la
                                            carpeta de la empresa.
                                        </p>
                                    )}

                                    {status.excelBiloop?.exists &&
                                        status.iaReport?.exists && (
                                            <p className="mt-3 text-sm text-gray-600">
                                                Ya existe informe IA para esta
                                                empresa y año.
                                            </p>
                                        )}

                                    {status.excelBiloop?.exists &&
                                        !status.iaReport?.exists &&
                                        !canGenerateReport && (
                                            <p className="mt-3 text-sm text-amber-700">
                                                Existe el Excel, pero falta el
                                                ID del archivo o de la carpeta.
                                                Revisa la respuesta de
                                                /api/rr/status.
                                            </p>
                                        )}
                                </div>
                            </div>
                        )}
                    </div>
                </section>
            </section>
        </main>
    );
}

function StatusCard(props: {
    title: string;
    exists: boolean;
    fileName?: string | null;
    url?: string | null;
}) {
    return (
        <div className="rounded-2xl border border-gray-200 p-4">
            <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold text-gray-950">{props.title}</h3>

                <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        props.exists
                            ? "bg-green-100 text-green-800"
                            : "bg-gray-100 text-gray-600"
                    }`}
                >
                    {props.exists ? "Existe" : "Pendiente"}
                </span>
            </div>

            <p className="mt-2 min-h-10 text-sm text-gray-600">
                {props.fileName || "No localizado todavía"}
            </p>

            {props.url && (
                <a
                    href={props.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex text-sm font-semibold text-gray-950 underline"
                >
                    Abrir documento
                </a>
            )}
        </div>
    );
}
