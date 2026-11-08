//! Native services can be tested without GTK/WebKit or a running webview.
pub mod discovery;
pub mod encoder;
#[cfg(feature = "desktop")]
mod host;
pub mod metadata;
pub mod preview;
pub mod process;
pub mod profiles;
pub mod queue;
pub mod script_check;
pub mod settings;
pub mod storage;
pub mod vapoursynth;
#[cfg(feature = "desktop")]
pub use host::run;
