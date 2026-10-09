//! PDF export: print.html renders the score in a hidden window, then WebView2's
//! PrintToPdf writes it (plan P1 route (a); Electron used webContents.printToPDF).
//! Page numbers come from a CSS @page margin box instead of Electron's footer template.
use serde_json::{Value, json};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder, webview::PageLoadEvent};

#[derive(Debug, Clone, PartialEq)]
pub struct PdfPage {
    /// Portrait paper size in inches.
    pub width: f64,
    pub height: f64,
    pub landscape: bool,
    pub margin_inches: f64,
    pub page_numbers: bool,
}

/// Same defaults and limits as electron/main.cjs.
pub fn pdf_options(raw: &Value) -> Result<(Value, PdfPage), String> {
    let mut pdf = json!({"start": 1, "scale": 0.9, "landscape": false, "separateTracks": false});
    if let Some(given) = raw.as_object() {
        for (key, value) in given {
            pdf[key] = value.clone();
        }
    }
    let invalid = || "PDF設定が不正です。".to_string();
    let scale = pdf["scale"].as_f64().ok_or_else(invalid)?;
    let start = pdf["start"].as_i64().ok_or_else(invalid)?;
    if !(0.6..=1.4).contains(&scale) || start < 1 {
        return Err(invalid());
    }
    if !pdf["end"].is_null() && pdf["end"].as_i64().is_none_or(|end| end < start) {
        return Err(invalid());
    }
    let layout = &pdf["layout"];
    let (width, height) = match layout["paper"].as_str() {
        Some("A3") => (11.69, 16.54),
        Some("Letter") => (8.5, 11.0),
        _ => (8.27, 11.69),
    };
    let margin_mm = layout["margin"].as_f64().filter(|m| *m > 0.0).unwrap_or(12.0);
    let page = PdfPage { width, height, landscape: pdf["landscape"] == Value::Bool(true), margin_inches: margin_mm / 25.4, page_numbers: layout["pageNumbers"] != Value::Bool(false) };
    Ok((pdf, page))
}

/// Script run in the print window: page-number margin box, then render, then report.
pub fn render_script(request: &Value, page: &PdfPage) -> String {
    let numbers = if page.page_numbers {
        "const s=document.createElement('style');s.textContent='@page{@bottom-center{content:counter(page) \" / \" counter(pages);font-size:9px;color:#555;font-family:sans-serif}}';document.head.append(s);"
    } else {
        ""
    };
    format!("window.__tabStudioPdf=null;(async()=>{{try{{{numbers}await window.renderPrintScore({request});window.__tabStudioPdf={{ok:true}};}}catch(e){{window.__tabStudioPdf={{error:String(e&&e.message||e)}};}}}})();")
}

fn wait_for_render(window: &tauri::WebviewWindow) -> Result<(), String> {
    for _ in 0..1200 {
        let (tx, rx) = mpsc::channel();
        window.eval_with_callback("window.__tabStudioPdf??null", move |result| { let _ = tx.send(result); }).map_err(|e| e.to_string())?;
        let result: Value = rx.recv_timeout(Duration::from_secs(10)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null);
        if result["ok"] == Value::Bool(true) {
            return Ok(());
        }
        if let Some(error) = result["error"].as_str() {
            return Err(error.to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("PDF用の譜面の準備が時間内に完了しませんでした。".into())
}

/// Renders one PDF (one track group) and returns its bytes. Must not run on the main thread.
pub fn render_pdf(app: &AppHandle, label: &str, request: &Value, page: &PdfPage, temp: &Path) -> Result<Vec<u8>, String> {
    let (loaded_tx, loaded_rx) = mpsc::channel();
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("print.html".into()))
        .visible(false)
        .inner_size(if page.landscape { 1140.0 } else { 820.0 }, if page.landscape { 820.0 } else { 1120.0 })
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = loaded_tx.send(());
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    let result = (|| {
        loaded_rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "PDF用の画面を開けませんでした。".to_string())?;
        window.eval(render_script(request, page)).map_err(|e| e.to_string())?;
        wait_for_render(&window)?;
        print_to_pdf(&window, page, temp)?;
        std::fs::read(temp).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(temp);
    let _ = window.destroy();
    result
}

#[cfg(windows)]
fn print_to_pdf(window: &tauri::WebviewWindow, page: &PdfPage, file: &Path) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT, ICoreWebView2_7, ICoreWebView2Environment6};
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{HSTRING, Interface};
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let page = page.clone();
    let path = HSTRING::from(file.as_os_str());
    window
        .with_webview(move |webview| {
            let start = || -> windows_core::Result<()> {
                unsafe {
                    let core = webview.controller().CoreWebView2()?.cast::<ICoreWebView2_7>()?;
                    let settings = webview.environment().cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()?;
                    settings.SetOrientation(if page.landscape { COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE } else { COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT })?;
                    settings.SetPageWidth(page.width)?;
                    settings.SetPageHeight(page.height)?;
                    settings.SetMarginTop(page.margin_inches)?;
                    settings.SetMarginBottom(page.margin_inches)?;
                    settings.SetMarginLeft(page.margin_inches)?;
                    settings.SetMarginRight(page.margin_inches)?;
                    settings.SetScaleFactor(1.0)?;
                    settings.SetShouldPrintBackgrounds(true)?;
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                    let done = tx.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                        let _ = done.send(if result.is_ok() && ok { Ok(()) } else { Err("PDFを作成できませんでした。".into()) });
                        Ok(())
                    }));
                    core.PrintToPdf(&path, &settings, &handler)
                }
            };
            if let Err(error) = start() {
                let _ = tx.send(Err(error.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(120)).map_err(|_| "PDFの作成が時間内に完了しませんでした。".to_string())?
}

#[cfg(not(windows))]
fn print_to_pdf(_window: &tauri::WebviewWindow, _page: &PdfPage, _file: &Path) -> Result<(), String> {
    Err("PDF書き出しはこの版ではまだ使えません。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_follow_electron_defaults_and_limits() {
        let (pdf, page) = pdf_options(&Value::Null).unwrap();
        assert_eq!(pdf["scale"], 0.9);
        assert_eq!(page, PdfPage { width: 8.27, height: 11.69, landscape: false, margin_inches: 12.0 / 25.4, page_numbers: true });
        let (_, page) = pdf_options(&json!({"landscape": true, "layout": {"paper": "Letter", "margin": 20, "pageNumbers": false}})).unwrap();
        assert!(page.landscape && !page.page_numbers && page.width == 8.5);
        assert!(pdf_options(&json!({"scale": 2})).is_err());
        assert!(pdf_options(&json!({"start": 0})).is_err());
        assert!(pdf_options(&json!({"start": 3, "end": 2})).is_err());
        assert!(pdf_options(&json!({"start": 1.5})).is_err());
        assert!(pdf_options(&json!({"start": 2, "end": 4})).is_ok());
    }

    #[test]
    fn script_embeds_the_request_as_json() {
        let page = pdf_options(&Value::Null).unwrap().1;
        let script = render_script(&json!({"scoreJson": "{\"a\":\"</script>\"}", "tracks": [0]}), &page);
        assert!(script.contains("renderPrintScore({\"scoreJson\":\"{\\\"a\\\":\\\"</script>\\\"}\",\"tracks\":[0]})"));
        assert!(script.contains("counter(pages)"));
        let (_, plain) = pdf_options(&json!({"layout": {"pageNumbers": false}})).unwrap();
        assert!(!render_script(&json!({}), &plain).contains("counter"));
    }
}
