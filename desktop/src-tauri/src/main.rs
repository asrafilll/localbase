//! Local Dev Hub menu-bar app.
//!
//! A tray icon (no windows) that polls the hub's REST API and shows every
//! project with its status. Each project has a submenu to open it, start,
//! stop or restart it, and Magic Login as any persona. A native notification
//! fires when a running service goes down unexpectedly.
//!
//! The hub itself stays a separate process (LaunchAgent or `pnpm start`);
//! "Start Local Dev Hub" launches it when it isn't reachable.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Runtime, Wry};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const TRAY_ID: &str = "devhub";
const POLL: Duration = Duration::from_secs(4);
/// Don't notify about services the user just stopped or restarted from here.
const QUIET_AFTER_ACTION: Duration = Duration::from_secs(20);

fn hub_url() -> String {
    std::env::var("DEVHUB_URL").unwrap_or_else(|_| "http://127.0.0.1:6969".into())
}

/// Repository root, known at build time because the app is built from the clone.
fn repo_root() -> String {
    std::env::var("DEVHUB_REPO")
        .unwrap_or_else(|_| format!("{}/../..", env!("CARGO_MANIFEST_DIR")))
}

#[derive(Default)]
struct State {
    /// Last overview JSON rendered into the menu (to skip identical rebuilds).
    last_menu: String,
    /// "project/service" -> status, for down notifications.
    services: HashMap<String, String>,
    /// project id -> when the user last acted on it from the menu.
    acted: HashMap<String, Instant>,
    /// Menu item id -> action, rebuilt with the menu.
    actions: HashMap<String, Action>,
}

#[derive(Clone)]
enum Action {
    OpenUrl(String),
    Post { path: String, body: Value, project: String },
    Login { project: String, persona: String },
    StartHub,
    Quit,
}

type Shared = Arc<Mutex<State>>;

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(800))
        .timeout(Duration::from_secs(60))
        .build()
}

fn get_overview() -> Option<Value> {
    agent()
        .get(&format!("{}/api/v1/overview", hub_url()))
        .timeout(Duration::from_secs(5))
        .call()
        .ok()?
        .into_json()
        .ok()
}

fn post(path: &str, body: &Value) -> Result<Value, String> {
    match agent()
        .post(&format!("{}/api/v1/{}", hub_url(), path))
        .send_json(body.clone())
    {
        Ok(res) => res.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(_, res)) => {
            let v: Value = res.into_json().unwrap_or(Value::Null);
            Err(v["error"].as_str().unwrap_or("request failed").to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn dot(status: &str) -> &'static str {
    match status {
        "running" => "●",
        "partial" => "◐",
        "invalid" | "error" => "✕",
        _ => "○",
    }
}

fn notify<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Builds the whole menu from an overview (or the "hub down" menu).
fn build_menu(app: &AppHandle<Wry>, overview: Option<&Value>, actions: &mut HashMap<String, Action>) -> tauri::Result<Menu<Wry>> {
    actions.clear();
    let menu = Menu::new(app)?;
    let mut next = 0usize;
    let mut item = |label: &str, action: Option<Action>| -> tauri::Result<MenuItem<Wry>> {
        next += 1;
        let id = format!("item-{next}");
        let enabled = action.is_some();
        if let Some(a) = action {
            actions.insert(id.clone(), a);
        }
        MenuItem::with_id(app, id, label, enabled, None::<&str>)
    };

    let Some(o) = overview else {
        menu.append(&item("Local Dev Hub is not running", None)?)?;
        menu.append(&item("Start Local Dev Hub", Some(Action::StartHub))?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&item("Quit", Some(Action::Quit))?)?;
        return Ok(menu);
    };

    let projects = o["projects"].as_array().cloned().unwrap_or_default();
    let running = projects
        .iter()
        .filter(|p| matches!(p["status"].as_str(), Some("running" | "partial")))
        .count();
    menu.append(&item(&format!("{running} of {} projects running", projects.len()), None)?)?;
    menu.append(&item("Open Dashboard…", Some(Action::OpenUrl(hub_url())))?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    for p in &projects {
        let id = p["id"].as_str().unwrap_or_default().to_string();
        let name = p["name"].as_str().unwrap_or(&id);
        let status = p["status"].as_str().unwrap_or("unknown");
        let sub = Submenu::new(app, format!("{} {}", dot(status), name), true)?;

        if let Some(url) = p["mainUrl"].as_str() {
            sub.append(&item(&format!("Open App  {}", url.trim_start_matches("http://")), Some(Action::OpenUrl(url.into())))?)?;
        }
        if let Some(url) = p["proxyUrl"].as_str() {
            sub.append(&item(&format!("Open {}", url.trim_start_matches("http://")), Some(Action::OpenUrl(url.into())))?)?;
        }
        for s in p["services"].as_array().into_iter().flatten() {
            if let (Some(url), false) = (s["url"].as_str(), s["url"] == p["mainUrl"]) {
                let label = format!("{} {}", dot(s["status"].as_str().unwrap_or("")), s["label"].as_str().unwrap_or(""));
                sub.append(&item(&label, Some(Action::OpenUrl(url.into())))?)?;
            }
        }

        let has_start = p["commandKeys"].as_array().is_some_and(|k| k.iter().any(|x| x == "start"));
        if has_start {
            sub.append(&PredefinedMenuItem::separator(app)?)?;
            let action = |verb: &str, body: Value| Action::Post {
                path: format!("projects/{id}/{verb}"),
                body,
                project: id.clone(),
            };
            if matches!(status, "running" | "partial") {
                sub.append(&item("Restart", Some(action("restart", json!({}))))?)?;
                sub.append(&item("Stop", Some(action("stop", json!({}))))?)?;
            } else {
                sub.append(&item("Start", Some(action("start", json!({ "killConflicts": false }))))?)?;
            }
        }

        let personas = p["personas"].as_array().cloned().unwrap_or_default();
        if p["magicLogin"].as_bool() == Some(true) && !personas.is_empty() {
            sub.append(&PredefinedMenuItem::separator(app)?)?;
            for persona in personas {
                let key = persona["key"].as_str().unwrap_or_default().to_string();
                let label = persona["label"].as_str().unwrap_or(&key);
                sub.append(&item(&format!("Login as {label}"), Some(Action::Login { project: id.clone(), persona: key }))?)?;
            }
        }

        sub.append(&PredefinedMenuItem::separator(app)?)?;
        sub.append(&item("Details…", Some(Action::OpenUrl(format!("{}/projects/{}", hub_url(), id))))?)?;
        menu.append(&sub)?;
    }

    if projects.is_empty() {
        menu.append(&item("Register a project…", Some(Action::OpenUrl(format!("{}/settings", hub_url()))))?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&item("Quit", Some(Action::Quit))?)?;
    Ok(menu)
}

/// Notifies about services that went from running to stopped/error.
fn check_transitions(app: &AppHandle<Wry>, overview: &Value, state: &mut State) {
    let mut now = HashMap::new();
    for p in overview["projects"].as_array().into_iter().flatten() {
        let id = p["id"].as_str().unwrap_or_default();
        let quiet = state.acted.get(id).is_some_and(|t| t.elapsed() < QUIET_AFTER_ACTION);
        for s in p["services"].as_array().into_iter().flatten() {
            let key = format!("{id}/{}", s["key"].as_str().unwrap_or_default());
            let status = s["status"].as_str().unwrap_or("unknown").to_string();
            if !quiet && state.services.get(&key).map(String::as_str) == Some("running") && matches!(status.as_str(), "stopped" | "error") {
                notify(
                    app,
                    &format!("{} · {} is {}", p["name"].as_str().unwrap_or(id), s["label"].as_str().unwrap_or(""), status),
                    s["detail"].as_str().unwrap_or(""),
                );
            }
            now.insert(key, status);
        }
    }
    state.services = now;
}

fn refresh(app: &AppHandle<Wry>, shared: &Shared) {
    let overview = get_overview();
    let mut state = shared.lock().unwrap();
    if let Some(o) = &overview {
        check_transitions(app, o, &mut state);
    }
    // Rebuild only when something visible changed.
    let key = overview
        .as_ref()
        .map(|o| {
            json!(o["projects"].as_array().map(|ps| ps.iter().map(|p| json!([p["id"], p["name"], p["status"], p["mainUrl"], p["proxyUrl"], p["personas"], p["commandKeys"], p["services"].as_array().map(|s| s.iter().map(|x| json!([x["key"], x["status"], x["url"]])).collect::<Vec<_>>())])).collect::<Vec<_>>()))
            .to_string()
        })
        .unwrap_or_else(|| "down".into());
    if key == state.last_menu {
        return;
    }
    state.last_menu = key;
    let mut actions = HashMap::new();
    let running = overview.as_ref().map(|o| {
        o["projects"].as_array().map_or(0, |ps| ps.iter().filter(|p| matches!(p["status"].as_str(), Some("running" | "partial"))).count())
    });
    if let Ok(menu) = build_menu(app, overview.as_ref(), &mut actions) {
        state.actions = actions;
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_menu(Some(menu));
            // macOS shows this text next to the icon.
            let _ = tray.set_title(Some(match running {
                Some(0) | None => String::new(),
                Some(n) => n.to_string(),
            }));
            let _ = tray.set_tooltip(Some(match running {
                None => "Local Dev Hub is not running".to_string(),
                Some(n) => format!("Local Dev Hub: {n} running"),
            }));
        }
    }
}

fn start_hub() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Prefer the LaunchAgent installed by `pnpm agent:install`.
        let uid = std::process::Command::new("id").arg("-u").output().map_err(|e| e.to_string())?;
        let uid = String::from_utf8_lossy(&uid.stdout).trim().to_string();
        let ok = std::process::Command::new("launchctl")
            .args(["kickstart", "-k", &format!("gui/{uid}/dev.localdevhub")])
            .status()
            .is_ok_and(|s| s.success());
        if ok {
            return Ok(());
        }
    }
    // Otherwise run the built server through a login shell (for node on PATH).
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let entry = format!("{}/.output/server/index.mjs", repo_root());
    if !std::path::Path::new(&entry).exists() {
        return Err(format!("{entry} not found: run `pnpm build` in the repo first"));
    }
    std::process::Command::new(shell)
        .args(["-lc", &format!("HOST=127.0.0.1 PORT=6969 exec node '{entry}'")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn handle(app: &AppHandle<Wry>, shared: &Shared, id: &str) {
    let Some(action) = shared.lock().unwrap().actions.get(id).cloned() else { return };
    let app = app.clone();
    let shared = shared.clone();
    // Network calls off the main thread so the menu never freezes.
    std::thread::spawn(move || {
        match action {
            Action::OpenUrl(url) => {
                let _ = app.opener().open_url(url, None::<&str>);
            }
            Action::Quit => app.exit(0),
            Action::StartHub => {
                if let Err(e) = start_hub() {
                    notify(&app, "Couldn't start Local Dev Hub", &e);
                }
            }
            Action::Login { project, persona } => {
                match post(&format!("projects/{project}/login"), &json!({ "persona": persona })) {
                    Ok(v) => {
                        if let Some(url) = v["url"].as_str() {
                            let _ = app.opener().open_url(url, None::<&str>);
                        }
                    }
                    Err(e) => notify(&app, "Magic Login failed", &e),
                }
            }
            Action::Post { path, body, project } => {
                shared.lock().unwrap().acted.insert(project.clone(), Instant::now());
                match post(&path, &body) {
                    Ok(v) if v["ok"] == false && v["conflicts"].is_array() => {
                        let ports: Vec<String> = v["conflicts"].as_array().unwrap().iter().map(|c| format!(":{}", c["port"])).collect();
                        notify(&app, &format!("{project}: port {} in use", ports.join(", ")), "Open the dashboard to stop the other process or start anyway.");
                        let _ = app.opener().open_url(format!("{}/projects/{project}", hub_url()), None::<&str>);
                    }
                    Ok(_) => {}
                    Err(e) => notify(&app, &format!("{project}: action failed"), &e),
                }
            }
        }
        let refresh_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            let shared = refresh_app.state::<Shared>().inner().clone();
            refresh(&refresh_app, &shared);
        });
    });
}

fn main() {
    let shared: Shared = Arc::new(Mutex::new(State::default()));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(shared.clone())
        .setup(move |app| {
            // Menu-bar only: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let loading = MenuItem::with_id(app, "loading", "Connecting to Local Dev Hub…", false, None::<&str>)?;
            let menu = Menu::with_items(app, &[&loading])?;
            let handler_state = shared.clone();
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Local Dev Hub")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| handle(app, &handler_state, event.id().as_ref()))
                .build(app)?;

            // Poll in the background; menu updates hop onto the main thread.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let shared = h.state::<Shared>().inner().clone();
                    refresh(&h, &shared);
                });
                std::thread::sleep(POLL);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Local Dev Hub menu-bar app");

    app.run(|_app, event| {
        // No windows: keep running until "Quit" is chosen.
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
