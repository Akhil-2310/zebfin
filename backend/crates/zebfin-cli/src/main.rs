//! `zebfin` — developer CLI for the Phase 0 testnet flow.
//!
//! Two roles, kept apart on purpose:
//! - `signer ...` is the approver's device. It holds the seed and signs.
//! - `wallet ...` and `pczt ...` are the backend. They hold only a viewing key.

use std::{
    io::{self, Write},
    path::PathBuf,
};

use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand};
use zebfin_signer::{DeviceSigner, SignerKeyFile};
use zebfin_wallet::{
    DEFAULT_SERVER, Recipient, Wallet, combine, connect, parse_pczt, prove, serialize_pczt,
    summarize,
};

#[derive(Parser)]
#[command(name = "zebfin", about = "Zebfin dev CLI (Zcash testnet only)")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Approver-device commands (hold the spending key)
    #[command(subcommand)]
    Signer(SignerCmd),
    /// Backend view-only wallet commands
    #[command(subcommand)]
    Wallet(WalletCmd),
    /// Backend PCZT commands
    #[command(subcommand)]
    Pczt(PcztCmd),
}

#[derive(Subcommand)]
enum SignerCmd {
    /// Generate a new 24-word seed and print the account's view-only export
    New {
        /// Where to write the key file (testnet only; keep it out of git)
        #[arg(long)]
        key: PathBuf,
        #[arg(long, default_value_t = 0)]
        account_index: u32,
    },
    /// Print the account's Orchard-only UFVK and seed fingerprint
    Export {
        #[arg(long)]
        key: PathBuf,
    },
    /// Show what a PCZT pays, ask for confirmation, then sign it
    Sign {
        #[arg(long)]
        key: PathBuf,
        /// The created (unproven) PCZT
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        /// Skip the interactive confirmation
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Args)]
struct WalletArgs {
    /// Backend wallet directory
    #[arg(long, short = 'w')]
    wallet: PathBuf,
    /// lightwalletd-compatible gRPC server
    #[arg(long, default_value = DEFAULT_SERVER)]
    server: String,
}

#[derive(Subcommand)]
enum WalletCmd {
    /// Import an approver's account as view-only
    Import {
        #[command(flatten)]
        w: WalletArgs,
        #[arg(long, default_value = "operating")]
        name: String,
        #[arg(long)]
        ufvk: String,
        #[arg(long)]
        seed_fingerprint: String,
        #[arg(long, default_value_t = 0)]
        account_index: u32,
        /// Birthday height (default: chain tip - 100)
        #[arg(long)]
        birthday: Option<u32>,
    },
    /// Scan the chain for this account's notes
    Sync {
        #[command(flatten)]
        w: WalletArgs,
    },
    Balance {
        #[command(flatten)]
        w: WalletArgs,
    },
    /// List sent and received outputs with decrypted memos
    History {
        #[command(flatten)]
        w: WalletArgs,
    },
    /// Look up a transaction and the chain tip on the server
    LookupTx {
        #[arg(long, default_value = zebfin_wallet::DEFAULT_SERVER)]
        server: String,
        txid: String,
    },
    /// Generate a fresh Orchard-only receiving address
    Address {
        #[command(flatten)]
        w: WalletArgs,
    },
}

#[derive(Subcommand)]
enum PcztCmd {
    /// Create an unsigned, unproven PCZT
    Create {
        #[command(flatten)]
        w: WalletArgs,
        /// Recipient as ADDRESS:ZATOSHIS[:MEMO]; repeat for multiple recipients
        #[arg(long = "to", required = true)]
        to: Vec<String>,
        #[arg(long)]
        output: PathBuf,
        /// Pad the transaction's action count to a multiple of this (0 disables)
        #[arg(long, default_value_t = 8)]
        pad_to: usize,
    },
    /// Print a JSON summary of a PCZT
    Inspect { input: PathBuf },
    /// Add zero-knowledge proofs (no spending key needed)
    Prove {
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    /// Combine proven + signed PCZTs, extract the transaction and broadcast it
    Send {
        #[command(flatten)]
        w: WalletArgs,
        #[arg(long)]
        proven: PathBuf,
        #[arg(long)]
        signed: PathBuf,
    },
}

fn read_key(path: &PathBuf) -> anyhow::Result<DeviceSigner> {
    let file: SignerKeyFile = serde_json::from_slice(
        &std::fs::read(path).with_context(|| format!("Reading {}", path.display()))?,
    )?;
    DeviceSigner::from_key_file(&file)
}

fn print_json<T: serde::Serialize>(v: &T) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

fn parse_recipient(s: &str) -> anyhow::Result<Recipient> {
    let mut parts = s.splitn(3, ':');
    let address = parts.next().unwrap_or_default().to_string();
    let value_zats = parts
        .next()
        .context("Expected ADDRESS:ZATOSHIS[:MEMO]")?
        .parse()
        .context("Invalid zatoshi amount")?;
    let memo = parts.next().map(str::to_string);
    Ok(Recipient {
        address,
        value_zats,
        memo,
    })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,schemerz=warn".into()),
        )
        .with_writer(io::stderr)
        .init();

    match Cli::parse().command {
        Command::Signer(cmd) => match cmd {
            SignerCmd::New { key, account_index } => {
                if key.exists() {
                    bail!("{} already exists; refusing to overwrite a seed", key.display());
                }
                let (signer, file) = DeviceSigner::generate(account_index)?;
                std::fs::write(&key, serde_json::to_vec_pretty(&file)?)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))?;
                }
                eprintln!("Wrote testnet seed to {}", key.display());
                print_json(&signer.export_account()?)?;
            }
            SignerCmd::Export { key } => print_json(&read_key(&key)?.export_account()?)?,
            SignerCmd::Sign {
                key,
                input,
                output,
                yes,
            } => {
                let signer = read_key(&key)?;
                let (summary, pczt) = summarize(parse_pczt(&std::fs::read(&input)?)?)?;
                eprintln!("This transaction will:");
                let padding = summary.payments.iter().filter(|p| p.value_zats == 0).count();
                for p in summary.payments.iter().filter(|p| p.value_zats > 0) {
                    eprintln!(
                        "  pay {:>14} zats -> {}",
                        p.value_zats,
                        p.address.as_deref().unwrap_or("?")
                    );
                }
                if padding > 0 {
                    eprintln!("  add {padding} zero-value padding outputs");
                }
                eprintln!("  return {} zats as change", summary.change_zats);
                eprintln!("  pay a fee of {} zats", summary.fee_zats);
                if !yes {
                    eprint!("Sign? [y/N] ");
                    io::stderr().flush()?;
                    let mut answer = String::new();
                    io::stdin().read_line(&mut answer)?;
                    if !answer.trim().eq_ignore_ascii_case("y") {
                        bail!("Not signed");
                    }
                }
                let signed = signer.sign(pczt)?;
                std::fs::write(&output, serialize_pczt(signed)?)?;
                eprintln!("Signed PCZT written to {}", output.display());
            }
        },
        Command::Wallet(cmd) => match cmd {
            WalletCmd::Import {
                w,
                name,
                ufvk,
                seed_fingerprint,
                account_index,
                birthday,
            } => {
                let mut client = connect(&w.server).await?;
                let mut wallet = Wallet::open(&w.wallet)?;
                let id = wallet
                    .import_account(&mut client, &name, &ufvk, &seed_fingerprint, account_index, birthday)
                    .await?;
                println!("Imported view-only account {id:?}");
            }
            WalletCmd::Sync { w } => {
                let mut client = connect(&w.server).await?;
                let mut wallet = Wallet::open(&w.wallet)?;
                wallet.sync(&mut client).await?;
                print_json(&wallet.balance()?)?;
            }
            WalletCmd::Balance { w } => print_json(&Wallet::open(&w.wallet)?.balance()?)?,
            WalletCmd::LookupTx { server, txid } => {
                let mut client = connect(&server).await?;
                let (tip, found) = zebfin_wallet::lookup_tx(&mut client, &txid).await?;
                println!("server tip: {tip}");
                match found {
                    Some(h) => println!("tx found, mined height: {h} (0 = mempool)"),
                    None => println!("tx NOT found on this server"),
                }
            }
            WalletCmd::History { w } => print_json(&Wallet::open(&w.wallet)?.history()?)?,
            WalletCmd::Address { w } => println!("{}", Wallet::open(&w.wallet)?.fresh_address()?),
        },
        Command::Pczt(cmd) => match cmd {
            PcztCmd::Create { w, to, output, pad_to } => {
                let recipients = to
                    .iter()
                    .map(|s| parse_recipient(s))
                    .collect::<anyhow::Result<Vec<_>>>()?;
                let mut wallet = Wallet::open(&w.wallet)?;
                // One-off lock owner; the locks lapse when the transaction expires.
                let pczt = wallet.create_pczt(&recipients, Some(pad_to), rand::random())?;
                std::fs::write(&output, serialize_pczt(pczt)?)?;
                eprintln!("PCZT written to {}", output.display());
            }
            PcztCmd::Inspect { input } => {
                let (summary, _) = summarize(parse_pczt(&std::fs::read(&input)?)?)?;
                print_json(&summary)?;
            }
            PcztCmd::Prove { input, output } => {
                eprintln!("Proving (building the Orchard proving key takes a few seconds)...");
                let proven = prove(parse_pczt(&std::fs::read(&input)?)?)?;
                std::fs::write(&output, serialize_pczt(proven)?)?;
                eprintln!("Proven PCZT written to {}", output.display());
            }
            PcztCmd::Send { w, proven, signed } => {
                let combined = combine(
                    parse_pczt(&std::fs::read(&proven)?)?,
                    parse_pczt(&std::fs::read(&signed)?)?,
                )?;
                let mut client = connect(&w.server).await?;
                let mut wallet = Wallet::open(&w.wallet)?;
                let txid = wallet.send(&mut client, combined).await?;
                println!("{txid}");
            }
        },
    }
    Ok(())
}

