use anchor_lang::prelude::*;

declare_id!("HczPXyfpBMCkeyR1Z2GptoxtbmWRRpUvsvjZ9iCyMwwq");

#[program]
pub mod shadowdex {
    use super::*;

    pub fn submit_order(
        ctx: Context<SubmitOrder>,
        order_id: u64,
        side: OrderSide,
        price: u64,  // in lamports per base unit
        size: u64,   // base units
    ) -> Result<()> {
        let order = &mut ctx.accounts.order;
        order.owner = ctx.accounts.user.key();
        order.order_id = order_id;
        order.side = side;
        order.price = price;
        order.size = size;
        order.filled = 0;
        order.status = OrderStatus::Open;
        order.timestamp = Clock::get()?.unix_timestamp;

        emit!(OrderSubmitted {
            order_id,
            owner: order.owner,
            side: side.clone(),
            price,
            size,
        });

        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let order = &mut ctx.accounts.order;
        require!(order.owner == ctx.accounts.user.key(), ShadowError::Unauthorized);
        require!(order.status == OrderStatus::Open, ShadowError::OrderNotOpen);
        order.status = OrderStatus::Cancelled;

        emit!(OrderCancelled { order_id: order.order_id, owner: order.owner });
        Ok(())
    }

    pub fn settle_match(
        ctx: Context<SettleMatch>,
        buy_order_id: u64,
        sell_order_id: u64,
        fill_price: u64,
        fill_size: u64,
    ) -> Result<()> {
        let buy = &mut ctx.accounts.buy_order;
        let sell = &mut ctx.accounts.sell_order;

        require!(buy.side == OrderSide::Buy, ShadowError::WrongSide);
        require!(sell.side == OrderSide::Sell, ShadowError::WrongSide);
        require!(buy.price >= fill_price, ShadowError::PriceMismatch);
        require!(sell.price <= fill_price, ShadowError::PriceMismatch);
        require!(fill_size <= buy.size - buy.filled, ShadowError::SizeExceeded);
        require!(fill_size <= sell.size - sell.filled, ShadowError::SizeExceeded);

        buy.filled += fill_size;
        sell.filled += fill_size;

        if buy.filled == buy.size  { buy.status = OrderStatus::Filled; }
        if sell.filled == sell.size { sell.status = OrderStatus::Filled; }

        emit!(TradeSettled {
            buy_order_id,
            sell_order_id,
            fill_price,
            fill_size,
            buyer: buy.owner,
            seller: sell.owner,
        });

        Ok(())
    }
}

// ── Accounts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct SubmitOrder<'info> {
    #[account(
        init,
        payer = user,
        space = Order::LEN,
        seeds = [b"order", user.key().as_ref(), &order_id.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut, has_one = owner @ ShadowError::Unauthorized)]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: matched via has_one
    pub owner: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct SettleMatch<'info> {
    #[account(mut)]
    pub buy_order: Account<'info, Order>,
    #[account(mut)]
    pub sell_order: Account<'info, Order>,
    /// The matching engine authority — will be the TEE session key in Step 2
    pub matcher: Signer<'info>,
}

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
pub struct Order {
    pub owner:     Pubkey,    // 32
    pub order_id:  u64,       // 8
    pub side:      OrderSide, // 1
    pub price:     u64,       // 8
    pub size:      u64,       // 8
    pub filled:    u64,       // 8
    pub status:    OrderStatus,// 1
    pub timestamp: i64,       // 8
    pub bump:      u8,        // 1
}

impl Order {
    pub const LEN: usize = 8 + 32 + 8 + 1 + 8 + 8 + 8 + 1 + 8 + 1 + 32; // padding
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum OrderSide { Buy, Sell }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum OrderStatus { Open, Filled, Cancelled }

// ── Events ────────────────────────────────────────────────────────────────────

#[event]
pub struct OrderSubmitted {
    pub order_id: u64,
    pub owner: Pubkey,
    pub side: OrderSide,
    pub price: u64,
    pub size: u64,
}

#[event]
pub struct OrderCancelled { pub order_id: u64, pub owner: Pubkey }

#[event]
pub struct TradeSettled {
    pub buy_order_id: u64,
    pub sell_order_id: u64,
    pub fill_price: u64,
    pub fill_size: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum ShadowError {
    #[msg("Not the order owner")] Unauthorized,
    #[msg("Order is not open")]   OrderNotOpen,
    #[msg("Wrong order side")]    WrongSide,
    #[msg("Price mismatch")]      PriceMismatch,
    #[msg("Fill size too large")] SizeExceeded,
}
