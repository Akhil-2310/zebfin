//! In-memory compact block cache for `zcash_client_backend::sync::run`.
//!
//! Blocks are only held between download and scan, then deleted, so nothing
//! about the chain is persisted outside the wallet database.

use std::{
    collections::BTreeMap,
    convert::Infallible,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use zcash_client_backend::{
    data_api::{
        chain::{BlockCache, BlockSource, error::Error as ChainError},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Clone, Default)]
pub struct MemBlockCache {
    blocks: Arc<Mutex<BTreeMap<BlockHeight, CompactBlock>>>,
}

fn height(block: &CompactBlock) -> BlockHeight {
    BlockHeight::from_u32(block.height as u32)
}

impl BlockSource for MemBlockCache {
    type Error = Infallible;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let blocks: Vec<CompactBlock> = {
            let guard = self.blocks.lock().unwrap();
            let start = from_height.unwrap_or(BlockHeight::from_u32(0));
            guard
                .range(start..)
                .take(limit.unwrap_or(usize::MAX))
                .map(|(_, b)| b.clone())
                .collect()
        };
        for block in blocks {
            with_block(block)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemBlockCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        let guard = self.blocks.lock().unwrap();
        Ok(match range {
            Some(r) => guard.range(r.block_range().clone()).next_back().map(|(h, _)| *h),
            None => guard.keys().next_back().copied(),
        })
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let guard = self.blocks.lock().unwrap();
        Ok(guard
            .range(range.block_range().clone())
            .map(|(_, b)| b.clone())
            .collect())
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut guard = self.blocks.lock().unwrap();
        for block in compact_blocks {
            guard.insert(height(&block), block);
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let mut guard = self.blocks.lock().unwrap();
        guard.retain(|h, _| !range.block_range().contains(h));
        Ok(())
    }
}
